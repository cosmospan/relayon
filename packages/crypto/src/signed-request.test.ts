import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signRequest, verifyRequest } from "./index.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const claims = { aud: "executor" as const, org_id: "org_a", project_id: "prj_a", connection_id: "con_a", op: "execute", action_id: "act_1" };

describe("signed internal requests (§11.2)", () => {
  it("verify with the right key and audience", () => {
    const t = signRequest(privateKey, claims);
    expect(verifyRequest(publicKey, t, "executor")).toMatchObject(claims);
  });

  it("reject another key, another audience, tampering and expiry", () => {
    const t = signRequest(privateKey, claims);
    expect(() => verifyRequest(generateKeyPairSync("ed25519").publicKey, t, "executor")).toThrow(/signature/);
    expect(() => verifyRequest(publicKey, t, "connect")).toThrow(/audience/);
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), org_id: "org_b" })).toString("base64url");
    expect(() => verifyRequest(publicKey, `${forged}.${s}`, "executor")).toThrow(/signature/);
    expect(() => verifyRequest(publicKey, t, "executor", Date.now() + 31_000)).toThrow(/expired/);
  });
});
