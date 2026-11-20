import { newId, withTenant } from "@relayon/db";
import { createTenant, setupMainDb } from "@relayon/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAction, canonicalJson, sha256, transition, verifyChain, type NewAction } from "./index.js";

let pools: Awaited<ReturnType<typeof setupMainDb>>;
let t: { orgId: string; projectId: string };

const action = (over: Partial<NewAction> = {}): NewAction => ({
  id: newId("action"), orgId: t.orgId, projectId: t.projectId, runId: null, parentActionId: null, endUserId: null, connectionId: null,
  toolId: "demo.update_record", source: "native", caller: "rest", principal: "key_x", agentName: null, model: null,
  input: { a: 1 }, inputHash: sha256("x"), idempotencyKey: null, kind: "update", reversibility: "reversible",
  policyDecision: "allow", policyRuleIds: [], status: "received", createdAt: new Date(), ...over,
});

beforeAll(async () => {
  pools = await setupMainDb();
  t = await createTenant(pools.owner, "ledger");
});
afterAll(async () => {
  await Promise.all([pools.owner.end(), pools.app.end(), pools.executor.end()]);
});

describe("canonicalJson", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe("ledger", () => {
  it("chains entries and detects tampering", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await withTenant(pools.app, t, (db) => appendAction(db, action()))).id);
    expect(await withTenant(pools.app, t, (db) => verifyChain(db, t.projectId))).toBeNull();
    // Even the owner bypassing the app can't silently rewrite history: the chain breaks.
    await withTenant(pools.owner, t, async (db) => {
      await db.query("alter table actions disable trigger actions_guard");
      await db.query("update actions set tool_id = 'demo.delete_record' where id = $1", [ids[1]]);
      await db.query("alter table actions enable trigger actions_guard");
    });
    expect(await withTenant(pools.app, t, (db) => verifyChain(db, t.projectId))).toBe(ids[1]);
  });

  it("transitions are guarded: only one of two racing transitions wins", async () => {
    const t2 = await createTenant(pools.owner, "race");
    const a = await withTenant(pools.app, t2, (db) => appendAction(db, { ...action(), orgId: t2.orgId, projectId: t2.projectId, status: "held" }));
    const [x, y] = await Promise.all([
      withTenant(pools.app, t2, (db) => transition(db, a.id, ["held"], "executing")),
      withTenant(pools.app, t2, (db) => transition(db, a.id, ["held"], "cancelled")),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
  });

  it("refuses to patch columns outside the allowlist", async () => {
    const a = await withTenant(pools.app, t, (db) => appendAction(db, action()));
    await expect(withTenant(pools.app, t, (db) => transition(db, a.id, ["received"], "previewed", { tool_id: "x" }))).rejects.toThrow(/may not be patched/);
  });
});
