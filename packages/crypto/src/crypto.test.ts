import { randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AwsKmsDecryptingProvider, AwsKmsEncryptingProvider, DekCache, DevKeyProvider, aadFor, open, seal } from "./index.js";

const ctxA = { org_id: "org_a", connection_id: "con_1", purpose: "credential" };

describe("AES-256-GCM sealing with AAD (§11.4)", () => {
  const dek = randomBytes(32);
  const aad = aadFor({ orgId: "org_a", connectionId: "con_1", field: "access_token", version: 1 });

  it("round-trips", () => {
    expect(open(dek, seal(dek, Buffer.from("secret"), aad), aad).toString()).toBe("secret");
  });

  it("uses a fresh nonce each time", () => {
    expect(seal(dek, Buffer.from("x"), aad).equals(seal(dek, Buffer.from("x"), aad))).toBe(false);
  });

  it("fails when the AAD is swapped to another org, connection or field", () => {
    const sealed = seal(dek, Buffer.from("secret"), aad);
    for (const other of [
      { orgId: "org_b", connectionId: "con_1", field: "access_token", version: 1 },
      { orgId: "org_a", connectionId: "con_2", field: "access_token", version: 1 },
      { orgId: "org_a", connectionId: "con_1", field: "refresh_token", version: 1 },
      { orgId: "org_a", connectionId: "con_1", field: "access_token", version: 2 },
    ]) {
      expect(() => open(dek, sealed, aadFor(other))).toThrow();
    }
  });

  it("fails on tampering", () => {
    const sealed = seal(dek, Buffer.from("secret"), aad);
    sealed[sealed.length - 1]! ^= 1;
    expect(() => open(dek, sealed, aad)).toThrow();
  });

  it("rejects separators inside AAD parts", () => {
    expect(() => aadFor({ orgId: "org|x", connectionId: "c", field: "f", version: 1 })).toThrow();
  });
});

describe("DevKeyProvider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("wraps and unwraps only under the same encryption context", async () => {
    const kp = new DevKeyProvider(randomBytes(32));
    const dk = await kp.generateDataKey(ctxA);
    expect((await kp.decryptDataKey(dk.wrapped, dk.kekRef, ctxA)).equals(dk.plaintext)).toBe(true);
    await expect(kp.decryptDataKey(dk.wrapped, dk.kekRef, { ...ctxA, org_id: "org_b" })).rejects.toThrow();
  });

  it("refuses to run in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new DevKeyProvider(randomBytes(32))).toThrow(/production/);
  });
});

describe("AWS KMS adapters", () => {
  it("pass the encryption context to KMS and split encrypt/decrypt", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GenerateDataKeyCommand) return { Plaintext: new Uint8Array(32), CiphertextBlob: new Uint8Array([1, 2]), KeyId: "arn:k" };
      if (cmd instanceof DecryptCommand) return { Plaintext: new Uint8Array(32).fill(7) };
      throw new Error("unexpected");
    });
    const enc = new AwsKmsEncryptingProvider({ send } as never, "arn:k");
    const dec = new AwsKmsDecryptingProvider({ send } as never);
    const dk = await enc.generateDataKey(ctxA);
    expect(dk.kekRef).toBe("arn:k");
    expect((send.mock.calls[0]![0] as GenerateDataKeyCommand).input.EncryptionContext).toEqual(ctxA);
    await dec.decryptDataKey(dk.wrapped, dk.kekRef, ctxA);
    expect((send.mock.calls[1]![0] as DecryptCommand).input.EncryptionContext).toEqual(ctxA);
    expect("decryptDataKey" in enc).toBe(false);
    expect("generateDataKey" in dec).toBe(false);
  });
});

describe("DekCache", () => {
  it("caches per DEK for the TTL, then re-fetches", async () => {
    let t = 0;
    const provider = { kind: "x", decryptDataKey: vi.fn(async () => randomBytes(32)) };
    const cache = new DekCache(provider, 1000, () => t);
    await cache.get("dek_1", Buffer.alloc(1), "k", ctxA);
    await cache.get("dek_1", Buffer.alloc(1), "k", ctxA);
    expect(provider.decryptDataKey).toHaveBeenCalledTimes(1);
    t = 1001;
    await cache.get("dek_1", Buffer.alloc(1), "k", ctxA);
    expect(provider.decryptDataKey).toHaveBeenCalledTimes(2);
  });
});
