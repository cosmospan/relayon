import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DevKeyProvider, signRequest } from "@relayon/crypto";
import { describe, expect, it, vi } from "vitest";
import { createConnectApp, credentialContext, storeCredential } from "./index.js";

const signer = generateKeyPairSync("ed25519");
const fakePool = { connect: vi.fn() } as never;

describe("connect", () => {
  it("binds the DEK context to org and connection", () => {
    expect(credentialContext("org_a", "con_b")).toEqual({ org_id: "org_a", connection_id: "con_b", purpose: "credential" });
  });

  it("refuses an empty credential before touching KMS or the vault", async () => {
    const kp = new DevKeyProvider(randomBytes(32));
    const spy = vi.spyOn(kp, "generateDataKey");
    await expect(storeCredential(fakePool, kp, { orgId: "org_a", connectionId: "con_b", fields: {} })).rejects.toThrow(/no credential/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects unsigned requests and unknown fields", async () => {
    const app = createConnectApp({ vault: fakePool, keyProvider: new DevKeyProvider(randomBytes(32)), apiPublicKey: signer.publicKey });
    expect((await app.request("/internal/credentials", { method: "POST", body: "{}" })).status).toBe(401);
    const body = JSON.stringify({ fields: { password: "x" } });
    const t = signRequest(signer.privateKey, { aud: "connect", org_id: "org_a", project_id: "prj_a", connection_id: "con_a", op: "store_credential" }, Date.now(), body);
    expect((await app.request("/internal/credentials", { method: "POST", headers: { "x-relayon-internal": t }, body })).status).toBe(422);
  });
});
