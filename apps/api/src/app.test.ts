import { generateKeyPairSync, randomBytes } from "node:crypto";
import { ConnectorRegistry, createToolRuntime } from "@relayon/connector-kit";
import { createDemoConnector } from "@relayon/connector-demo";
import { DekCache, DevKeyProvider } from "@relayon/crypto";
import { withTenant } from "@relayon/db";
import { setupMainDb } from "@relayon/db/testing";
import { ExecutorClient, Relay, SnapshotSealer } from "@relayon/engine";
import { createExecutorApp } from "@relayon/executor";
import { verifyChain } from "@relayon/ledger";
import { setupVaultDb } from "@relayon/vault-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, createApp } from "./index.js";

const pepper = randomBytes(32);
const signer = generateKeyPairSync("ed25519");
const demo = createDemoConnector();

let main: Awaited<ReturnType<typeof setupMainDb>>;
let vault: Awaited<ReturnType<typeof setupVaultDb>>;
let app: ReturnType<typeof createApp>;
let relay: Relay;
const scheduled: Array<{ orgId: string; projectId: string; actionId: string; executeAt: Date }> = [];
let A: { orgId: string; projectId: string; key: string; keyId: string };
let approverKey: string;
let B: { key: string };
let connectionId: string;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, key = A.key, headers: Record<string, string> = {}): Promise<{ status: number; body: J }> {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
const act = (tool: string, input: unknown, extra: J = {}, key = A.key, headers: Record<string, string> = {}) => call("POST", "/v1/actions", { tool, input, ...extra }, key, headers);
const record = (id: string) => demo.store.get(connectionId, id);

beforeAll(async () => {
  main = await setupMainDb();
  vault = await setupVaultDb();
  const keyProvider = new DevKeyProvider(randomBytes(32));
  // Executor in-process: the same code that runs in the vault zone.
  const executorRegistry = new ConnectorRegistry().register(demo);
  const executor = createExecutorApp({
    mainRo: main.executor, vault: vault.executor, dekCache: new DekCache(keyProvider), trustedSigners: [signer.publicKey],
    runtime: createToolRuntime(executorRegistry), instanceId: "test",
  });
  const transport = {
    async exec(token: string, params: unknown) {
      const res = await executor.request("/internal/exec", { method: "POST", headers: { "x-relayon-exec": token, "content-type": "application/json" }, body: JSON.stringify({ params }) });
      const json = (await res.json()) as J;
      if (res.status !== 200) {
        const { RelayonError } = await import("@relayon/core");
        throw new RelayonError(json.error.code, json.error.message, { details: json.error.details });
      }
      return json.result;
    },
  };
  relay = new Relay({
    pool: main.app, registry: new ConnectorRegistry().register(createDemoConnector()),
    executor: new ExecutorClient(transport, signer.privateKey), sealer: new SnapshotSealer(randomBytes(32)),
    holds: { schedule: async (j) => void scheduled.push(j) },
  });
  app = createApp({ pool: main.app, pepper, relay, allowedOrigins: ["https://claude.ai"] });
  A = await bootstrap(main.app, pepper, "tenant-a");
  approverKey = (await bootstrap(main.app, pepper, "approver", ["actions:read", "approvals:decide"], A)).key;
  B = await bootstrap(main.app, pepper, "tenant-b");
  const c = await call("POST", "/v1/connections", { app: "demo" });
  expect(c.status).toBe(201);
  connectionId = c.body.id;
  await call("POST", "/v1/connections", { app: "demo" }, B.key);
});

afterAll(async () => {
  await Promise.all([main.owner.end(), main.app.end(), main.executor.end(), vault.owner.end(), vault.executor.end(), vault.connect.end()]);
});

describe("auth (§8.1, §11.5)", () => {
  it("rejects missing, malformed and unknown keys", async () => {
    expect((await call("GET", "/v1/tools", undefined, "")).status).toBe(401);
    expect((await call("GET", "/v1/tools", undefined, "rl_live_nope")).status).toBe(401);
    const fake = A.key.slice(0, -10) + "aaaaaaaaaa";
    expect((await call("GET", "/v1/tools", undefined, fake)).status).toBe(401);
  });

  it("lists tools with schemas", async () => {
    const r = await call("GET", "/v1/tools?app=demo");
    expect(r.body.tools.map((t: J) => t.id)).toContain("demo.update_record");
  });
});

describe("relay pipeline: allow → snapshot → execute → undo (Week 1–2 exit)", () => {
  it("creates, updates with a diff, and undoes back to the snapshot", async () => {
    const created = await act("demo.create_record", { title: "Acme deal", status: "open" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ status: "succeeded", reversibility: "reversible", undo: { available: true } });
    const recId = created.body.result.id;

    const upd = await act("demo.update_record", { id: recId, changes: { status: "won", title: "Acme deal (closed)" } });
    expect(upd.status).toBe(200);
    expect(upd.body.preview.fields).toEqual(expect.arrayContaining([
      { path: "status", before: "open", after: "won" },
      { path: "title", before: "Acme deal", after: "Acme deal (closed)" },
    ]));
    expect(upd.body.preview.fields).toHaveLength(2);
    expect(record(recId)).toMatchObject({ status: "won", title: "Acme deal (closed)" });

    const undo = await call("POST", `/v1/actions/${upd.body.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ status: "succeeded", steps: [{ result: "undone" }] });
    expect(record(recId)).toMatchObject({ status: "open", title: "Acme deal" });

    const after = await call("GET", `/v1/actions/${upd.body.id}`);
    expect(after.body.undo.status).toBe("undone");
    const again = await call("POST", `/v1/actions/${upd.body.id}/undo`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("RELAYON_UNDO_NOT_POSSIBLE");

    // The undo step is itself a logged action with parent_action_id.
    const child = await call("GET", `/v1/actions/${undo.body.steps[0].undo_action_ids[0]}`);
    expect(child.body).toMatchObject({ parent_action_id: upd.body.id, status: "succeeded", policy: { rules: ["relayon:undo"] } });
  });

  it("detects conflicts and only overrides them with force", async () => {
    const rec = (await act("demo.create_record", { title: "Conflict" })).body.result.id;
    const upd = await act("demo.update_record", { id: rec, changes: { status: "agent" } });
    demo.store.put(connectionId, { ...record(rec)!, status: "human-edit" }); // a human changes the same field
    const u = await call("POST", `/v1/actions/${upd.body.id}/undo`, {});
    expect(u.status).toBe(409);
    expect(u.body.error).toMatchObject({ code: "RELAYON_UNDO_CONFLICT", details: { report: { steps: [{ changed_fields: ["status"] }] } } });
    expect(record(rec)!.status).toBe("human-edit");
    const forced = await call("POST", `/v1/actions/${upd.body.id}/undo`, { force: true });
    expect(forced.status).toBe(200);
    expect(record(rec)!.status).toBe("open");
  });

  it("fails closed when the target can't be previewed/snapshotted", async () => {
    const r = await act("demo.update_record", { id: "rec_missing", changes: { status: "x" } });
    expect(r.status).toBe(502);
    expect(r.body.error.action_id).toMatch(/^act_/);
    expect((await call("GET", `/v1/actions/${r.body.error.action_id}`)).body.status).toBe("failed");
  });

  it("validates input strictly", async () => {
    const r = await act("demo.create_record", { title: "x", hack: true });
    expect(r.status).toBe(422);
    expect((await act("demo.nope", {})).status).toBe(404);
  });

  it("honours idempotency keys (same body → same action; different body → conflict)", async () => {
    const h = { "idempotency-key": `idem-${Date.now()}` };
    const a = await act("demo.create_record", { title: "Once" }, {}, A.key, h);
    const b = await act("demo.create_record", { title: "Once" }, {}, A.key, h);
    expect(b.body.id).toBe(a.body.id);
    const c = await act("demo.create_record", { title: "Twice" }, {}, A.key, h);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("RELAYON_IDEMPOTENCY_CONFLICT");
  });

  it("previews without executing", async () => {
    const rec = (await act("demo.create_record", { title: "Preview me" })).body.result.id;
    const p = await call("POST", "/v1/actions/preview", { tool: "demo.delete_record", input: { id: rec } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: "previewed", preview: { op: "delete", summary: 'Delete record "Preview me"' } });
    expect(record(rec)!.trashed).toBe(false);
  });
});

describe("policies, approvals and holds (§7)", () => {
  beforeAll(async () => {
    const p = await call("PUT", "/v1/policies", {
      name: "safety", format: "yaml",
      source: `version: 1
name: safety
rules:
  - id: approve-deletes
    match: { kind: [delete] }
    decision: require_approval
  - id: hold-sends
    match: { kind: send }
    decision: hold
    hold_seconds: 60
  - id: block-forbidden
    match: { tool: demo.create_record }
    when: 'input.title.startsWith("FORBIDDEN")'
    decision: block
    message: "No forbidden titles."
`,
    });
    expect(p.status).toBe(200);
  });

  it("blocks by policy and records it", async () => {
    const r = await act("demo.create_record", { title: "FORBIDDEN thing" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "RELAYON_POLICY_BLOCKED", message: "No forbidden titles." });
    expect((await call("GET", `/v1/actions/${r.body.error.action_id}`)).body.status).toBe("blocked");
  });

  it("requires approval for deletes; the requester can't approve; a separate approver can; undo restores", async () => {
    const rec = (await act("demo.create_record", { title: "To delete" })).body.result.id;
    const d = await act("demo.delete_record", { id: rec });
    expect(d.status).toBe(202);
    expect(d.body).toMatchObject({ status: "pending_approval", policy: { decision: "require_approval", rules: ["approve-deletes"] } });
    expect(record(rec)!.trashed).toBe(false);

    const list = await call("GET", "/v1/approvals", undefined, approverKey);
    const ap = list.body.approvals.find((x: J) => x.action_id === d.body.id);
    expect(ap).toBeTruthy();

    const self = await call("POST", `/v1/approvals/${ap.id}/approve`, {}, A.key);
    expect(self.status).toBe(403);

    const ok = await call("POST", `/v1/approvals/${ap.id}/approve`, {}, approverKey);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("succeeded");
    expect(record(rec)!.trashed).toBe(true);

    expect((await call("POST", `/v1/actions/${d.body.id}/undo`, {})).status).toBe(200);
    expect(record(rec)!.trashed).toBe(false);
  });

  it("rejection means nothing runs", async () => {
    const rec = (await act("demo.create_record", { title: "Keep me" })).body.result.id;
    const d = await act("demo.delete_record", { id: rec });
    const r = await call("POST", `/v1/approvals/${d.body.approval.id}/reject`, { reason: "no" }, approverKey);
    expect(r.body).toMatchObject({ status: "rejected", error: { code: "RELAYON_APPROVAL_REJECTED", message: "no" } });
    expect(record(rec)!.trashed).toBe(false);
  });

  it("holds sends; cancel wins over the job; the job runs exactly once", async () => {
    const h1 = await act("demo.send_message", { to: "jane@acme.com", text: "hi" });
    expect(h1.status).toBe(202);
    expect(h1.body.status).toBe("held");
    expect(scheduled.at(-1)!.actionId).toBe(h1.body.id);
    expect((await call("POST", `/v1/actions/${h1.body.id}/cancel`, {})).body.status).toBe("cancelled");
    expect(await relay.runHeld(A, h1.body.id)).toBe("skipped");

    const h2 = await act("demo.send_message", { to: "bob@acme.com", text: "hello" });
    const [x, y] = await Promise.all([relay.runHeld(A, h2.body.id), relay.runHeld(A, h2.body.id)]);
    expect([x, y].sort()).toEqual(["executed", "skipped"]);
    const v = await call("GET", `/v1/actions/${h2.body.id}`);
    expect(v.body).toMatchObject({ status: "succeeded", reversibility: "irreversible", undo: { available: false, status: "not_possible" } });
    expect(demo.store.messages(connectionId).map((m) => m.to)).toEqual(["bob@acme.com"]);
  });

  it("the sweeper picks up holds whose job was lost", async () => {
    const h = await act("demo.send_message", { to: "sweep@acme.com", text: "x" });
    await withTenant(main.app, A, (db) => db.query("update held_actions set execute_at = now() - interval '1 minute' where action_id = $1", [h.body.id]));
    expect(await relay.sweepHolds()).toBeGreaterThanOrEqual(1);
    expect((await call("GET", `/v1/actions/${h.body.id}`)).body.status).toBe("succeeded");
  });
});

describe("run undo (US-5)", () => {
  it("undoes a whole run newest first and skips irreversible steps", async () => {
    const run = `run-e2e-${Date.now()}`;
    const c = await act("demo.create_record", { title: "Run rec" }, { run_id: run });
    const id = c.body.result.id;
    await act("demo.update_record", { id, changes: { status: "step1" } }, { run_id: run });
    await act("demo.update_record", { id, changes: { status: "step2", body: "x" } }, { run_id: run });
    const u = await call("POST", `/v1/runs/${run}/undo`, {});
    expect(u.status).toBe(200);
    expect(u.body.status).toBe("succeeded");
    expect(u.body.steps.map((s: J) => s.tool)).toEqual(["demo.update_record", "demo.update_record", "demo.create_record"]);
    expect(record(id)).toMatchObject({ status: "open", body: "", trashed: true });
    const r = await call("GET", `/v1/runs/${run}`);
    expect(r.body.status).toBe("undone");
    expect((await call("GET", `/v1/undo-ops/${u.body.undo_op_id}`)).body.status).toBe("succeeded");
  });
});

describe("tenant isolation through the API (§11.5)", () => {
  it("org B cannot see, undo, cancel or approve org A's actions", async () => {
    const a = await act("demo.create_record", { title: "A only" });
    expect((await call("GET", `/v1/actions/${a.body.id}`, undefined, B.key)).status).toBe(404);
    expect((await call("POST", `/v1/actions/${a.body.id}/undo`, {}, B.key)).status).toBe(404);
    expect((await call("POST", `/v1/actions/${a.body.id}/cancel`, {}, B.key)).status).toBe(404);
    const rec = (await act("demo.create_record", { title: "A del" })).body.result.id;
    const d = await act("demo.delete_record", { id: rec });
    expect((await call("POST", `/v1/approvals/${d.body.approval.id}/approve`, {}, B.key)).status).toBe(404);
    expect((await call("GET", "/v1/actions", undefined, B.key)).body.actions.every((x: J) => x.id !== a.body.id)).toBe(true);
    // B's demo store is a different connection: A's record doesn't exist there.
    expect((await act("demo.get_record", { id: a.body.result.id }, {}, B.key)).status).toBe(502);
  });

  it("keeps a valid hash chain", async () => {
    expect(await withTenant(main.app, A, (db) => verifyChain(db, A.projectId))).toBeNull();
  });
});

describe("MCP endpoint (§8.1–8.2)", () => {
  const rpc = (body: unknown, headers: Record<string, string> = {}) => call("POST", "/mcp", body, A.key, headers);

  it("initializes, lists app + meta tools, and calls a tool with _meta.relayon", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "relayon" } });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.body.result.tools.map((t: J) => t.name);
    expect(names).toEqual(expect.arrayContaining(["demo_create_record", "demo_update_record", "relayon_undo", "relayon_preview", "relayon_wait_for_action"]));

    const created = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo_create_record", arguments: { title: "From MCP" } } }, { "relayon-run-id": "mcp-run-1" });
    const sc = created.body.result.structuredContent;
    expect(created.body.result.isError).toBe(false);
    expect(sc._meta.relayon).toMatchObject({ status: "succeeded", reversibility: "reversible", undo_available: true });
    const recId = sc.result.id;

    const undo = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "relayon_undo", arguments: { action_id: sc.id } } });
    expect(undo.body.result.structuredContent.status).toBe("succeeded");
    expect(record(recId)!.trashed).toBe(true);
  });

  it("returns policy outcomes as tool results, not protocol errors", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "demo_create_record", arguments: { title: "FORBIDDEN x" } } });
    expect(r.body.result).toMatchObject({ isError: true, structuredContent: { error: { code: "RELAYON_POLICY_BLOCKED" } } });
    const held = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "demo_send_message", arguments: { to: "x@y.z", text: "t" } } });
    expect(held.body.result.structuredContent.status).toBe("held");
    const cancelled = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "relayon_cancel_action", arguments: { action_id: held.body.result.structuredContent.id } } });
    expect(cancelled.body.result.structuredContent.status).toBe("cancelled");
  });

  describe("protocol 2026-07-28 (stateless, no handshake)", () => {
    const V = "2026-07-28";
    const env = (method: string, params: J = {}) => ({ ...params, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" } } });
    const hdrs = (method: string, name?: string): Record<string, string> => ({ "mcp-protocol-version": V, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

    it("serves server/discover, tools/list with cache hints, and tools/call without initialize", async () => {
      const d = await rpc({ jsonrpc: "2.0", id: "d1", method: "server/discover", params: env("server/discover") }, hdrs("server/discover"));
      expect(d.status).toBe(200);
      expect(d.body.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining([V, "2025-11-25"]), capabilities: { tools: {} }, cacheScope: "public" });
      expect(d.body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("relayon");
      expect(d.body.result.ttlMs).toBeGreaterThanOrEqual(0);

      const l = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: env("tools/list") }, hdrs("tools/list"));
      expect(l.body.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
      const names = l.body.result.tools.map((t: J) => t.name);
      expect(names).toEqual([...names].sort());

      const c = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: env("tools/call", { name: "demo_create_record", arguments: { title: "Modern MCP" } }) }, hdrs("tools/call", "demo_create_record"));
      expect(c.body.result).toMatchObject({ resultType: "complete", isError: false });
      expect(c.body.result._meta.relayon.status).toBe("succeeded");
    });

    it("rejects header/body mismatches, missing envelope fields and unknown versions with 400", async () => {
      const call = (h: Record<string, string>, params: J = env("tools/call", { name: "demo_list_records", arguments: {} })) =>
        rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params }, h);
      const noHeader = await call({ "mcp-method": "tools/call", "mcp-name": "demo_list_records" });
      expect([noHeader.status, noHeader.body.error.code]).toEqual([400, -32020]);
      const wrongName = await call(hdrs("tools/call", "relayon_undo"));
      expect([wrongName.status, wrongName.body.error.code]).toEqual([400, -32020]);
      const wrongMethod = await call(hdrs("tools/list", "demo_list_records"));
      expect([wrongMethod.status, wrongMethod.body.error.code]).toEqual([400, -32020]);
      const noCaps = await call(hdrs("tools/call", "demo_list_records"), { name: "demo_list_records", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": V } });
      expect([noCaps.status, noCaps.body.error.code]).toEqual([400, -32602]);
      const future = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } }, { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" });
      expect(future.status).toBe(400);
      expect(future.body.error).toMatchObject({ code: -32022, data: { requested: "2099-01-01", supported: expect.arrayContaining([V]) } });
      const headerOnly = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/list" }, hdrs("tools/list"));
      expect([headerOnly.status, headerOnly.body.error.code]).toEqual([400, -32602]);
    });

    it("has no handshake, ping or subscriptions in the new dialect", async () => {
      for (const m of ["initialize", "ping", "subscriptions/listen"]) {
        const r = await rpc({ jsonrpc: "2.0", id: 12, method: m, params: env(m) }, hdrs(m));
        expect([r.status, r.body.error.code]).toEqual([404, -32601]);
      }
    });
  });

  it("validates Origin and auth on every request", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://claude.ai" })).status).toBe(200);
    const res = await app.request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).body.error.code).toBe(-32600);
  });
});
