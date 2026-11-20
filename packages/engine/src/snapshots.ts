import { open, seal } from "@relayon/crypto";

/**
 * Encrypts snapshot before/after JSON at rest (§2.2 "Encrypted (§11)"). AAD binds each blob to its
 * org, action and slot. MVP uses one app-level 256-bit key from the secret manager; moving this to
 * per-org KMS data keys is tracked in docs/security/threat-model.md.
 */
export class SnapshotSealer {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("snapshot key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  #aad(orgId: string, actionId: string, slot: "before" | "after") {
    return Buffer.from(`snapshot|${orgId}|${actionId}|${slot}`);
  }

  seal(orgId: string, actionId: string, slot: "before" | "after", value: unknown): Buffer {
    return seal(this.#key, Buffer.from(JSON.stringify(value ?? null)), this.#aad(orgId, actionId, slot));
  }

  open<T = unknown>(orgId: string, actionId: string, slot: "before" | "after", blob: Buffer): T {
    return JSON.parse(open(this.#key, blob, this.#aad(orgId, actionId, slot)).toString("utf8")) as T;
  }
}
