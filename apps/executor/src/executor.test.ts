import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createConnectApp } from "@relayon/connect";
import { DekCache, DevKeyProvider, signRequest } from "@relayon/crypto";
import { newId, withTenant } from "@relayon/db";
import { createTenant, setupMainDb } from "@relayon/db/testing";
import { setupVaultDb } from "@relayon/vault-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutorApp, type ToolInvocation } from "./index.js";

const signer = generateKeyPairSync("ed25519");
const keyProvider = new DevKeyProvider(randomBytes(32));
const SECRET = `lin_api_${randomBytes(24).toString("hex")}`;

let main: Awaited<ReturnType<typeof setupMainDb>>;
let vault: Awaited<ReturnType<typeof setupVaultDb>>;
let tenant: { orgId: string; projectId: string };
let other: { orgId: string; projectId: string };
let connectionId: string;
const seen: ToolInvocation[] = [];
let executor: ReturnType<typeof createExecutorApp>;

async function newAction(status = "executing", input: unknown = { title: "hi" }) {
  const id = newId("action");
  const inputHash = createHash("sha256").update(JSON.stringify(input)).digest();
  await withTenant(main.app, tenant, (db) =>
    db.query(
      `insert into actions(id, org_id, project_id, connection_id, tool_id, source, caller, input, input_hash, kind, reversibility, policy_decision, status)
       values ($1,$2,$3,$4,'demo.echo','native','rest',$5,$6,'update','reversible','allow',$7)`,
      [id, tenant.orgId, tenant.projectId, connectionId, JSON.stringify(input), inputHash, status],
    ),
  );
  return { id, inputHash: inputHash.toString("hex") };
}

function token(a: { id: string; inputHash: string }, over: Record<string, string> = {}) {
  return signRequest(signer.privateKey, {
    aud: "executor", org_id: tenant.orgId, project_id: tenant.projectId, connection_id: connectionId,
    op: "execute", action_id: a.id, tool_id: "demo.echo", input_hash: a.inputHash, ...over,
  });
}

async function exec(t: string) {
  const res = await executor.request("/internal/exec", { method: "POST", headers: { "x-relayon-exec": t, "content-type": "application/json" }, body: "{}" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  main = await setupMainDb();
  vault = await setupVaultDb();
  tenant = await createTenant(main.owner, "exec");
  other = await createTenant(main.owner, "other");
  connectionId = newId("connection");
  await withTenant(main.app, tenant, (db) =>
    db.query(`insert into connections(id, org_id, project_id, app, auth_type, status) values ($1,$2,$3,'demo','api_key','active')`, [connectionId, tenant.orgId, tenant.projectId]),
  );
  // Store the credential through the Connect service (encrypt-only path).
  const connect = createConnectApp({ vault: vault.connect, keyProvider, apiPublicKey: signer.publicKey });
  const body = JSON.stringify({ fields: { api_key: SECRET } });
  const t = signRequest(signer.privateKey, { aud: "connect", org_id: tenant.orgId, project_id: tenant.projectId, connection_id: connectionId, op: "store_credential" }, Date.now(), body);
  const res = await connect.request("/internal/credentials", { method: "POST", headers: { "x-relayon-internal": t }, body });
  expect(res.status).toBe(200);
  expect(JSON.stringify(await res.json())).not.toContain(SECRET);

  executor = createExecutorApp({
    mainRo: main.executor,
    vault: vault.executor,
    dekCache: new DekCache(keyProvider),
    trustedSigners: [signer.publicKey],
    instanceId: "test",
    runtime: {
      run: async (inv) => {
        seen.push(inv);
        // A misbehaving connector that tries to leak the token in several ways.
        return { ok: true, echoed: `token=${inv.credential?.apiKey}`, api_key: inv.credential?.apiKey, nested: [inv.credential?.apiKey] };
      },
    },
  });
});

afterAll(async () => {
  await Promise.all([main.owner.end(), main.app.end(), main.executor.end(), vault.owner.end(), vault.executor.end(), vault.connect.end()]);
});

describe("executor (§11.2, §11.4)", () => {
  it("decrypts just in time, gives the connector the credential, and redacts it from the result", async () => {
    const a = await newAction();
    const r = await exec(token(a));
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.credential!.apiKey).toBe(SECRET);
    expect(seen.at(-1)!.input).toEqual({ title: "hi" });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const log = await withTenant(vault.owner, { orgId: tenant.orgId }, (db) => db.query("select purpose, action_id from decrypt_log where action_id = $1", [a.id]));
    expect(log.rows).toEqual([{ purpose: "execute", action_id: a.id }]);
  });

  it("rejects a replayed request", async () => {
    const a = await newAction();
    const t = token(a);
    expect((await exec(t)).status).toBe(200);
    expect((await exec(t)).status).toBe(403);
  });

  it("re-checks the action itself: wrong status, input hash, tool, connection or tenant are refused", async () => {
    const pending = await newAction("pending_approval");
    expect((await exec(token(pending))).status).toBe(403);
    const a = await newAction();
    expect((await exec(token(a, { input_hash: "00".repeat(32) }))).status).toBe(403);
    expect((await exec(token(a, { tool_id: "demo.other" }))).status).toBe(403);
    expect((await exec(token(a, { connection_id: newId("connection") }))).status).toBe(403);
    expect((await exec(token(a, { org_id: other.orgId, project_id: other.projectId }))).status).toBe(403);
  });

  it("refuses unsigned or foreign-signed requests", async () => {
    const a = await newAction();
    expect((await exec("garbage")).status).toBe(401);
    const foreign = signRequest(generateKeyPairSync("ed25519").privateKey, {
      aud: "executor", org_id: tenant.orgId, project_id: tenant.projectId, connection_id: connectionId, op: "execute", action_id: a.id, tool_id: "demo.echo", input_hash: a.inputHash,
    });
    expect((await exec(foreign)).status).toBe(401);
  });

  it("connect refuses a body that is not the one that was signed", async () => {
    const connect = createConnectApp({ vault: vault.connect, keyProvider, apiPublicKey: signer.publicKey });
    const t = signRequest(signer.privateKey, { aud: "connect", org_id: tenant.orgId, project_id: tenant.projectId, connection_id: connectionId, op: "store_credential" }, Date.now(), "{}");
    const res = await connect.request("/internal/credentials", { method: "POST", headers: { "x-relayon-internal": t }, body: JSON.stringify({ fields: { api_key: "x" } }) });
    expect(res.status).toBe(401);
    // A token signed without a body cannot be used for a body-carrying request either.
    const unbound = signRequest(signer.privateKey, { aud: "connect", org_id: tenant.orgId, project_id: tenant.projectId, connection_id: connectionId, op: "store_credential" });
    const res2 = await connect.request("/internal/credentials", { method: "POST", headers: { "x-relayon-internal": unbound }, body: "{}" });
    expect(res2.status).toBe(401);
  });
});
