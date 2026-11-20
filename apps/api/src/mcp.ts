import type { TenantContext } from "@relayon/authz";
import { RelayonError } from "@relayon/core";
import type { ActionView, Relay } from "@relayon/engine";
import { z } from "zod";

/**
 * MCP over Streamable HTTP (§8.1–8.2), stateless: every POST /mcp carries one JSON-RPC message and
 * gets one application/json response. No protocol sessions; run ids are server-side state handles
 * bound to the authenticated principal.
 */
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

type RpcId = string | number | null;
interface RpcReq { jsonrpc: "2.0"; id?: RpcId; method: string; params?: Record<string, unknown> }

const META_TOOLS = [
  {
    name: "relayon_preview",
    description: "Dry-run any tool: returns the diff, reversibility and the policy decision. Does not execute.",
    inputSchema: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool", "input"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "relayon_undo",
    description: "Undo one action (action_id) or a whole run (run_id), newest first. Stops on conflicts unless force is true.",
    inputSchema: { type: "object", properties: { action_id: { type: "string" }, run_id: { type: "string" }, force: { type: "boolean" } }, additionalProperties: false },
  },
  {
    name: "relayon_wait_for_action",
    description: "Wait (up to 60 s) for a held or pending action to finish, then return its status.",
    inputSchema: { type: "object", properties: { action_id: { type: "string" }, timeout_seconds: { type: "number", maximum: 60 } }, required: ["action_id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "relayon_cancel_action",
    description: "Cancel a held action before it executes.",
    inputSchema: { type: "object", properties: { action_id: { type: "string" } }, required: ["action_id"], additionalProperties: false },
  },
  {
    name: "relayon_list_actions",
    description: "List recent ledger entries, optionally for one run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, limit: { type: "number", maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "relayon_search_tools",
    description: "Search the tool catalog by intent and return the best matching tools with their schemas.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const rpcError = (id: RpcId, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0" as const, id, error: { code, message, ...(data ? { data } : {}) } });

function relayonMeta(v: ActionView) {
  return { action_id: v.id, run_id: v.run_id, status: v.status, reversibility: v.reversibility, undo_available: v.undo.available, cost_usd: v.cost_usd };
}

function summary(v: ActionView): string {
  switch (v.status) {
    case "succeeded": return `Done (${v.tool}). Action ${v.id}${v.undo.available ? " can be undone with relayon_undo." : "."}`;
    case "pending_approval": return `Waiting for human approval (action ${v.id}). Continue other work or call relayon_wait_for_action.`;
    case "held": return `Held until ${v.hold?.execute_at ?? "later"} (action ${v.id}); it can be cancelled with relayon_cancel_action.`;
    case "blocked": return `Blocked by policy: ${v.error?.message ?? ""}`;
    case "failed": return `Failed: ${v.error?.message ?? "error"}`;
    default: return `Action ${v.id} is ${v.status}.`;
  }
}

function toolResult(v: ActionView, isError = false) {
  const structured = { ...v, _meta: { relayon: relayonMeta(v) } };
  return { content: [{ type: "text", text: summary(v) }], structuredContent: structured, isError: isError || v.status === "failed" || v.status === "blocked", _meta: { relayon: relayonMeta(v) } };
}

function errorResult(e: RelayonError) {
  const body = e.toBody();
  return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], structuredContent: body, isError: true };
}

export async function handleMcp(relay: Relay, ctx: TenantContext, msg: unknown, headers: { runId?: string; endUser?: string }): Promise<unknown | null> {
  if (Array.isArray(msg)) return rpcError(null, -32600, "Batching is not supported");
  const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).safeParse(msg);
  if (!parsed.success) return rpcError(null, -32600, "Invalid request");
  const req = parsed.data as RpcReq;
  const id = req.id ?? null;
  if (req.id === undefined) return null; // notification: nothing to return (202)

  try {
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "relayon", version: "0.1.0" },
          instructions: "Every write is previewed, logged, and either reversible or held for approval. Use relayon_undo to reverse actions.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list": {
        const apps = new Set((await relay.listConnections(ctx)).filter((c) => c.status === "active").map((c) => c.app as string));
        const tools = relay.registry.list().filter((t) => apps.has(t.app)).map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { ...(t.annotations ?? {}), readOnlyHint: t.kind === "read", destructiveHint: t.kind === "delete" || t.kind === "send" || t.kind === "pay" },
          _meta: { relayon: { tool_id: t.id, kind: t.kind, reversibility: t.reversibility } },
        }));
        return rpcResult(id, { tools: [...tools, ...META_TOOLS] });
      }
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        return rpcResult(id, await callTool(relay, ctx, name, args, headers));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e) {
    if (e instanceof RelayonError) {
      if (req.method === "tools/call") return rpcResult(id, errorResult(e));
      return rpcError(id, -32000, e.message, e.toBody());
    }
    return rpcError(id, -32603, "Internal error");
  }
}

async function callTool(relay: Relay, ctx: TenantContext, name: string, args: Record<string, unknown>, h: { runId?: string; endUser?: string }) {
  const a = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  switch (name) {
    case "relayon_preview": {
      const { view } = await relay.submit(ctx, { tool: String(args.tool ?? ""), input: args.input ?? {}, runId: h.runId ?? null, endUser: h.endUser ?? null, caller: "mcp" }, { previewOnly: true });
      return toolResult(view);
    }
    case "relayon_undo": {
      const report = a("run_id") ? await relay.undoRun(ctx, a("run_id")!, { force: args.force === true }) : await relay.undoAction(ctx, a("action_id") ?? "", { force: args.force === true });
      return { content: [{ type: "text", text: `Undo ${report.status}: ${report.steps.map((s) => `${s.tool} ${s.result}`).join(", ")}` }], structuredContent: report, isError: report.status !== "succeeded" };
    }
    case "relayon_wait_for_action": {
      const deadline = Date.now() + Math.min(Number(args.timeout_seconds ?? 30), 60) * 1000;
      let v = await relay.view(ctx, a("action_id") ?? "");
      while (["held", "pending_approval", "approved", "executing", "received", "previewed"].includes(v.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        v = await relay.view(ctx, v.id);
      }
      return toolResult(v);
    }
    case "relayon_cancel_action":
      return toolResult(await relay.cancel(ctx, a("action_id") ?? ""));
    case "relayon_list_actions": {
      const list = await relay.list(ctx, { runId: a("run_id"), limit: Number(args.limit ?? 20) });
      return { content: [{ type: "text", text: list.map((v) => `${v.id} ${v.tool} ${v.status}`).join("\n") || "No actions." }], structuredContent: { actions: list }, isError: false };
    }
    case "relayon_search_tools": {
      const q = (a("query") ?? "").toLowerCase().split(/\W+/).filter(Boolean);
      const scored = relay.registry.list().map((t) => ({ t, s: q.filter((w) => `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(w)).length })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 5);
      return { content: [{ type: "text", text: scored.map((x) => `${x.t.name}: ${x.t.description}`).join("\n") || "No match." }], structuredContent: { tools: scored.map((x) => ({ name: x.t.name, description: x.t.description, inputSchema: x.t.inputSchema })) }, isError: false };
    }
    default: {
      const input = { ...args };
      const relayonArgs = (input._relayon ?? {}) as { idempotency_key?: string; run_id?: string };
      delete input._relayon;
      const { view } = await relay.submit(ctx, {
        tool: name, input, caller: "mcp", runId: relayonArgs.run_id ?? h.runId ?? null, endUser: h.endUser ?? null,
        idempotencyKey: relayonArgs.idempotency_key ?? null,
      });
      return toolResult(view);
    }
  }
}
