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

  it("binds the exact body into the signature without putting a digest of it in the token", () => {
    const body = JSON.stringify({ fields: { api_key: "planted-fake-secret-123" } });
    const t = signRequest(privateKey, claims, Date.now(), body);
    expect(verifyRequest(publicKey, t, "executor", Date.now(), body)).toMatchObject({ ...claims, body_bound: true });
    const decoded = Buffer.from(t.split(".")[0]!, "base64url").toString("utf8");
    expect(decoded).not.toMatch(/[0-9a-f]{64}/);
    expect(decoded).not.toContain("planted-fake-secret-123");
    expect(() => verifyRequest(publicKey, t, "executor", Date.now(), body + " ")).toThrow(/signature/);
    expect(() => verifyRequest(publicKey, t, "executor")).toThrow(/body binding/);
    const unbound = signRequest(privateKey, claims);
    expect(() => verifyRequest(publicKey, unbound, "executor", Date.now(), body)).toThrow(/body binding/);
  });
});
