import type { KeyObject } from "node:crypto";
import type { TenantContext } from "@relayon/authz";
import { RelayonError } from "@relayon/core";
import { sha256Hex, signRequest } from "@relayon/crypto";
import type { Relay } from "@relayon/engine";
import { compilePolicy } from "@relayon/policy";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { authenticate } from "./auth.js";
import { handleMcp } from "./mcp.js";
import { readJson } from "./validate.js";

export interface ApiDeps {
  pool: pg.Pool;
  pepper: Buffer;
  relay: Relay;
  /** Forwards an API-key credential to the Connect service; the API never stores it. */
  connect?: { post: (path: string, headers: Record<string, string>, body: unknown) => Promise<{ status: number; json: unknown }>; signingKey: KeyObject };
  /** Allowed browser origins for /mcp. Requests with any other Origin get 403 (§8.1, §11.8). */
  allowedOrigins?: readonly string[];
}

type Env = { Variables: { ctx: TenantContext } };

const idParam = z.string().regex(/^[a-z]+_[0-9a-z]{26}$/);

const SubmitBody = z.object({
  tool: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  end_user: z.string().min(1).max(200).optional(),
  run_id: z.string().min(1).max(200).optional(),
  agent_name: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
}).strict();

export function createApp(deps: ApiDeps) {
  const app = new Hono<Env>();
  const relay = deps.relay;

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    c.set("ctx", await authenticate(deps.pool, deps.pepper, c.req.header("authorization")));
    await next();
  });
  const ctxOf = (c: Context<Env>) => c.get("ctx");
  const id = (c: Context<Env>) => {
    const r = idParam.safeParse(c.req.param("id"));
    if (!r.success) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Not found");
    return r.data;
  };

  // ---- tools
  app.get("/v1/tools", (c) => c.json({ tools: relay.registry.list({ app: c.req.query("app") ?? undefined, kind: c.req.query("kind") ?? undefined }) }));

  // ---- actions
  const submit = async (c: Context<Env>, previewOnly: boolean) => {
    const b = await readJson(c.req, SubmitBody);
    const { httpStatus, view } = await relay.submit(ctxOf(c), {
      tool: b.tool, input: b.input, endUser: b.end_user ?? c.req.header("relayon-end-user") ?? null, runId: b.run_id ?? c.req.header("relayon-run-id") ?? null,
      agentName: b.agent_name ?? null, model: b.model ?? null, idempotencyKey: previewOnly ? null : c.req.header("idempotency-key") ?? null, caller: "rest",
    }, { previewOnly });
    return c.json(view, httpStatus as 200);
  };
  app.post("/v1/actions", (c) => submit(c, false));
  app.post("/v1/actions/preview", (c) => submit(c, true));
  app.get("/v1/actions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ actions: await relay.list(ctxOf(c), { runId: c.req.query("run_id"), toolId: c.req.query("tool"), status: c.req.query("status"), limit: Number.isFinite(limit) ? limit : 50 }) });
  });
  app.get("/v1/actions/:id", async (c) => c.json(await relay.view(ctxOf(c), id(c))));
  app.post("/v1/actions/:id/cancel", async (c) => c.json(await relay.cancel(ctxOf(c), id(c))));
  app.post("/v1/actions/:id/undo", async (c) => {
    const b = await readJson(c.req, z.object({ force: z.boolean().default(false) }).strict());
    return c.json(await relay.undoAction(ctxOf(c), id(c), { force: b.force }));
  });

  // ---- runs
  app.post("/v1/runs", async (c) => {
    const b = await readJson(c.req, z.object({ external_id: z.string().max(200).optional(), agent_name: z.string().max(100).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).strict());
    return c.json(await relay.openRun(ctxOf(c), b), 201);
  });
  app.get("/v1/runs/:id", async (c) => c.json(await relay.getRun(ctxOf(c), c.req.param("id").slice(0, 200))));
  app.post("/v1/runs/:id/undo", async (c) => {
    const b = await readJson(c.req, z.object({ force: z.boolean().default(false), include_compensations: z.boolean().default(false) }).strict());
    return c.json(await relay.undoRun(ctxOf(c), c.req.param("id").slice(0, 200), { force: b.force, includeCompensations: b.include_compensations }));
  });
  app.get("/v1/undo-ops/:id", async (c) => c.json(await relay.getUndoOp(ctxOf(c), id(c))));

  // ---- approvals
  app.get("/v1/approvals", async (c) => c.json({ approvals: await relay.listApprovals(ctxOf(c), c.req.query("status") ?? "pending") }));
  app.post("/v1/approvals/:id/approve", async (c) => {
    const b = await readJson(c.req, z.object({ edited_input: z.unknown().optional() }).strict());
    if (b.edited_input !== undefined) throw new RelayonError("RELAYON_INVALID_INPUT", "Editing input on approval is not supported yet");
    const r = await relay.decide(ctxOf(c), id(c), "approve");
    return c.json(r.view, r.httpStatus as 200);
  });
  app.post("/v1/approvals/:id/reject", async (c) => {
    const b = await readJson(c.req, z.object({ reason: z.string().max(1000).optional() }).strict());
    const r = await relay.decide(ctxOf(c), id(c), "reject", b.reason);
    return c.json(r.view, r.httpStatus as 200);
  });

  // ---- connections
  app.get("/v1/connections", async (c) => c.json({ connections: await relay.listConnections(ctxOf(c)) }));
  app.post("/v1/connections", async (c) => {
    const b = await readJson(c.req, z.object({ app: z.string().min(1).max(50), end_user: z.string().max(200).optional(), account_label: z.string().max(200).optional(), api_key: z.string().min(1).max(8192).optional() }).strict(), 64 * 1024);
    const ctx = ctxOf(c);
    const conn = await relay.createConnection(ctx, { app: b.app, end_user: b.end_user, account_label: b.account_label });
    if (conn.needs_secret && b.api_key) {
      if (!deps.connect) throw new RelayonError("RELAYON_INTERNAL", "Connect service not configured");
      const body = { fields: { api_key: b.api_key } };
      const token = signRequest(deps.connect.signingKey, { aud: "connect", org_id: ctx.orgId, project_id: ctx.projectId, connection_id: conn.id, op: "store_credential", body_sha256: sha256Hex(JSON.stringify(body)) });
      const res = await deps.connect.post("/internal/credentials", { "x-relayon-internal": token }, body);
      if (res.status !== 200) throw new RelayonError("RELAYON_INTERNAL", "Could not store the credential");
      await relay.activateConnection(ctx, conn.id);
      return c.json({ ...conn, status: "active" }, 201);
    }
    return c.json(conn, 201);
  });

  // ---- policies
  const PolicyBody = z.object({ name: z.string().min(1).max(100), format: z.enum(["yaml", "json"]), source: z.string().min(1).max(256 * 1024), priority: z.number().int().min(0).max(10_000).optional(), enabled: z.boolean().optional() }).strict();
  app.get("/v1/policies", async (c) => c.json({ policies: await relay.listPolicies(ctxOf(c)) }));
  app.put("/v1/policies", async (c) => c.json(await relay.putPolicy(ctxOf(c), await readJson(c.req, PolicyBody))));
  app.post("/v1/policies/validate", async (c) => {
    const b = await readJson(c.req, PolicyBody.pick({ format: true, source: true }));
    const p = compilePolicy(b.source, b.format);
    return c.json({ valid: true, rules: p.rules.map((r) => r.id) });
  });

  // ---- MCP (Streamable HTTP, stateless JSON responses)
  app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { allow: "POST" }));
  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed" } }, 403);
    let ctx: TenantContext;
    try {
      ctx = await authenticate(deps.pool, deps.pepper, c.req.header("authorization"));
    } catch (e) {
      return c.json((e as RelayonError).toBody(), 401, { "www-authenticate": 'Bearer realm="relayon"' });
    }
    const raw = await c.req.text();
    if (raw.length > 1024 * 1024) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Body too large" } }, 413);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const out = await handleMcp(relay, ctx, msg, { runId: c.req.header("relayon-run-id")?.slice(0, 200), endUser: c.req.header("relayon-end-user")?.slice(0, 200) });
    if (out === null) return c.body(null, 202);
    return c.json(out);
  });

  app.notFound((c) => c.json(new RelayonError("RELAYON_TOOL_NOT_FOUND", "Route not found").toBody(), 404));
  app.onError((err, c) => {
    if (err instanceof RelayonError) return c.json(err.toBody(), err.status as 400);
    // Never echo internal error text: it can carry upstream data.
    console.error(JSON.stringify({ msg: "unhandled error", name: (err as Error).name }));
    return c.json(new RelayonError("RELAYON_INTERNAL", "Internal error").toBody(), 500);
  });

  return app;
}
