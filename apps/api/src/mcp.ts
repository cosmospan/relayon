import type { TenantContext } from "@relayon/authz";
import { RelayonError } from "@relayon/core";
import type { ActionView, Relay } from "@relayon/engine";
import { z } from "zod";

/**
 * MCP over Streamable HTTP (§8.1–8.2), stateless: every POST /mcp carries one JSON-RPC message and
 * gets one application/json response. No protocol sessions; run ids are server-side state handles
 * bound to the authenticated principal.
 *
 * Two dialects share this endpoint:
 * - 2026-07-28 ("modern"): no initialize handshake; every request carries
 *   `_meta["io.modelcontextprotocol/protocolVersion"]` and `clientCapabilities`, plus the
 *   MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, which must match the body. Results carry
 *   `resultType`, and list/discover results carry `ttlMs` + `cacheScope`.
 * - 2025-11-25 and older ("legacy"): initialize + ping, plain results.
 */
export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: "relayon", version: "0.1.0" };
const INSTRUCTIONS = "Every write is previewed, logged, and either reversible or held for approval. Use relayon_undo to reverse actions.";
const CAPABILITIES = { tools: { listChanged: false } };
/** Methods whose target name must be mirrored in the Mcp-Name header (2026-07-28 Streamable HTTP). */
const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

export interface McpHeaders {
  runId?: string;
  endUser?: string;
  protocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
}
/** HTTP status + JSON body (null body = 202 Accepted for notifications). */
export interface McpReply {
  status: number;
  body: unknown | null;
}

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

export async function handleMcp(relay: Relay, ctx: TenantContext, msg: unknown, headers: McpHeaders): Promise<McpReply> {
  if (Array.isArray(msg)) return { status: 400, body: rpcError(null, -32600, "Batching is not supported") };
  const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).safeParse(msg);
  if (!parsed.success) return { status: 400, body: rpcError(null, -32600, "Invalid request") };
  const req = parsed.data as RpcReq;
  const id = req.id ?? null;
  const meta = (req.params?._meta ?? {}) as Record<string, unknown>;
  const metaVersion = meta["io.modelcontextprotocol/protocolVersion"];

  if (metaVersion !== undefined) {
    // ---- 2026-07-28: validate the per-request envelope before anything else.
    if (typeof metaVersion !== "string" || !MODERN_VERSIONS.includes(metaVersion)) {
      return { status: 400, body: rpcError(id, -32022, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: String(metaVersion) }) };
    }
    if (headers.protocolVersion !== metaVersion) return { status: 400, body: rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version header does not match _meta protocolVersion") };
    if (headers.mcpMethod !== req.method) return { status: 400, body: rpcError(id, -32020, "Header mismatch: Mcp-Method header does not match the request method") };
    if (NAMED_METHODS.has(req.method) && headers.mcpName !== String(req.params?.name ?? "")) {
      return { status: 400, body: rpcError(id, -32020, "Header mismatch: Mcp-Name header does not match params.name") };
    }
    const caps = meta["io.modelcontextprotocol/clientCapabilities"];
    if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
      return { status: 400, body: rpcError(id, -32602, "Missing _meta io.modelcontextprotocol/clientCapabilities") };
    }
    if (req.id === undefined) return { status: 202, body: null };
    return handleModern(relay, ctx, req, id, headers);
  }

  // ---- Legacy dialect (no per-request _meta version).
  if (headers.protocolVersion !== undefined && !LEGACY_VERSIONS.includes(headers.protocolVersion)) {
    if (MODERN_VERSIONS.includes(headers.protocolVersion)) {
      return { status: 400, body: rpcError(id, -32602, "Missing _meta io.modelcontextprotocol/protocolVersion") };
    }
    return { status: 400, body: rpcError(id, -32022, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: headers.protocolVersion }) };
  }
  if (req.id === undefined) return { status: 202, body: null };
  try {
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        return ok(rpcResult(id, {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }));
      }
      case "ping":
        return ok(rpcResult(id, {}));
      case "tools/list":
        return ok(rpcResult(id, { tools: await listTools(relay, ctx) }));
      case "tools/call":
        return ok(rpcResult(id, await callTool(relay, ctx, String(req.params?.name ?? ""), (req.params?.arguments ?? {}) as Record<string, unknown>, headers)));
      default:
        return ok(rpcError(id, -32601, `Method not found: ${req.method}`));
    }
  } catch (e) {
    if (e instanceof RelayonError) {
      if (req.method === "tools/call") return ok(rpcResult(id, errorResult(e)));
      return ok(rpcError(id, -32000, e.message, e.toBody()));
    }
    return ok(rpcError(id, -32603, "Internal error"));
  }
}

const ok = (body: unknown): McpReply => ({ status: 200, body });

async function handleModern(relay: Relay, ctx: TenantContext, req: RpcReq, id: RpcId, headers: McpHeaders): Promise<McpReply> {
  const serverMeta = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
  try {
    switch (req.method) {
      case "server/discover":
        return ok(rpcResult(id, {
          resultType: "complete",
          supportedVersions: ALL_VERSIONS,
          capabilities: CAPABILITIES,
          instructions: INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: "public",
          _meta: serverMeta,
        }));
      case "tools/list":
        // The list depends on the caller's active connections, so it is private and short-lived.
        return ok(rpcResult(id, { resultType: "complete", tools: await listTools(relay, ctx), ttlMs: 30_000, cacheScope: "private", _meta: serverMeta }));
      case "tools/call": {
        const r = (await callTool(relay, ctx, String(req.params?.name ?? ""), (req.params?.arguments ?? {}) as Record<string, unknown>, headers)) as Record<string, unknown>;
        return ok(rpcResult(id, { ...r, resultType: "complete", _meta: { ...((r._meta as object) ?? {}), ...serverMeta } }));
      }
      case "subscriptions/listen":
        return { status: 404, body: rpcError(id, -32601, "Subscriptions not supported", { reason: "This server is stateless and emits no list-change notifications." }) };
      default:
        return { status: 404, body: rpcError(id, -32601, `Method not found: ${req.method}`) };
    }
  } catch (e) {
    if (e instanceof RelayonError && req.method === "tools/call") {
      return ok(rpcResult(id, { ...errorResult(e), resultType: "complete", _meta: serverMeta }));
    }
    return { status: 500, body: rpcError(id, -32603, "Internal error") };
  }
}

async function listTools(relay: Relay, ctx: TenantContext) {
  const apps = new Set((await relay.listConnections(ctx)).filter((c) => c.status === "active").map((c) => c.app as string));
  const tools = relay.registry.list().filter((t) => apps.has(t.app)).map((t) => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { ...(t.annotations ?? {}), readOnlyHint: t.kind === "read", destructiveHint: t.kind === "delete" || t.kind === "send" || t.kind === "pay" },
    _meta: { relayon: { tool_id: t.id, kind: t.kind, reversibility: t.reversibility } },
  }));
  // Deterministic order (2026-07-28 asks for it; it also keeps client caches stable).
  return [...tools, ...META_TOOLS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function callTool(relay: Relay, ctx: TenantContext, name: string, args: Record<string, unknown>, h: McpHeaders) {
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
