import { generateKeyPairSync, randomBytes } from "node:crypto";
import { verifyRequest } from "@relayon/crypto";
import { describe, expect, it } from "vitest";
import { ExecutorClient, SnapshotSealer } from "./index.js";

describe("SnapshotSealer", () => {
  const s = new SnapshotSealer(randomBytes(32));
  it("round-trips and binds blobs to org, action and slot", () => {
    const blob = s.seal("org_a", "act_1", "before", { status: "open" });
    expect(s.open("org_a", "act_1", "before", blob)).toEqual({ status: "open" });
    expect(() => s.open("org_b", "act_1", "before", blob)).toThrow();
    expect(() => s.open("org_a", "act_2", "before", blob)).toThrow();
    expect(() => s.open("org_a", "act_1", "after", blob)).toThrow();
  });
});

describe("ExecutorClient", () => {
  it("signs a fresh single-use request per call bound to the action", async () => {
    const kp = generateKeyPairSync("ed25519");
    const tokens: string[] = [];
    const c = new ExecutorClient({ exec: async (t) => { tokens.push(t); return { ok: 1 }; } }, kp.privateKey);
    const target = { orgId: "org_a", projectId: "prj_a", connectionId: null, actionId: "act_1", toolId: "demo.x", inputHash: Buffer.alloc(32, 1) };
    await c.run("execute", target);
    await c.run("execute", target);
    const [a, b] = tokens.map((t) => verifyRequest(kp.publicKey, t, "executor"));
    expect(a).toMatchObject({ op: "execute", action_id: "act_1", connection_id: "none", input_hash: "01".repeat(32) });
    expect(a!.nonce).not.toBe(b!.nonce);
  });
});
