import { newId } from "@relayon/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintRls, withTenant } from "@relayon/db";
import { recordDecrypt } from "./index.js";
import { setupVaultDb } from "./testing/index.js";

let pools: Awaited<ReturnType<typeof setupVaultDb>>;
const orgA = newId("org");
const orgB = newId("org");

beforeAll(async () => {
  pools = await setupVaultDb();
});
afterAll(async () => {
  await Promise.all([pools.owner.end(), pools.executor.end(), pools.connect.end()]);
});

async function seedCredential(orgId: string) {
  const dekId = newId("dek");
  const conId = newId("connection");
  await withTenant(pools.connect, { orgId }, async (db) => {
    await db.query("insert into org_keys(id, org_id, kms_key_arn, wrapped_dek, context) values ($1,$2,'dev:local','\\x01','{}')", [dekId, orgId]);
    await db.query("insert into credentials(id, connection_id, org_id, api_key_enc, dek_id) values ($1,$2,$3,'\\x02',$4)", [newId("credential"), conId, orgId, dekId]);
  });
  return { dekId, conId };
}

describe("vault DB (§11.4)", () => {
  it("has forced RLS on every table", async () => {
    const c = await pools.owner.connect();
    try {
      expect(await lintRls(c)).toEqual([]);
    } finally {
      c.release();
    }
  });

  it("connect role can write secrets but cannot read ciphertext", async () => {
    const { conId } = await seedCredential(orgA);
    await expect(withTenant(pools.connect, { orgId: orgA }, (db) => db.query("select api_key_enc from credentials where connection_id=$1", [conId]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(pools.connect, { orgId: orgA }, (db) => db.query("select wrapped_dek from org_keys"))).rejects.toThrow(/permission denied/);
    const ok = await withTenant(pools.connect, { orgId: orgA }, (db) => db.query("select id from credentials where connection_id=$1", [conId]));
    expect(ok.rowCount).toBe(1);
  });

  it("executor can read only its tenant's ciphertext and cannot delete", async () => {
    const { conId } = await seedCredential(orgA);
    const asB = await withTenant(pools.executor, { orgId: orgB }, (db) => db.query("select id from credentials where connection_id=$1", [conId]));
    expect(asB.rowCount).toBe(0);
    await expect(withTenant(pools.executor, { orgId: orgA }, (db) => db.query("delete from credentials where connection_id=$1", [conId]))).rejects.toThrow(/permission denied/);
  });

  it("burns nonces (replay → false) and keeps decrypt_log append-only", async () => {
    const e = { orgId: orgA, connectionId: "con_x", actionId: null, purpose: "execute" as const, nonce: newId("action"), executorInstance: "t" };
    expect(await recordDecrypt(pools.executor, e)).toBe(true);
    expect(await recordDecrypt(pools.executor, e)).toBe(false);
    await expect(withTenant(pools.owner, { orgId: orgA }, (db) => db.query("delete from decrypt_log"))).rejects.toThrow(/append-only/);
  });
});
