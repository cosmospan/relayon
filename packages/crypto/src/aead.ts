import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Sealed-field wire format (bytea): [version=1][nonce 12][tag 16][ciphertext]. */
const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface FieldAad {
  orgId: string;
  connectionId: string;
  field: string;
  version: number;
}

/** AAD = org_id|connection_id|field|version (§11.4). Binds ciphertext to its tenant and slot. */
export function aadFor(a: FieldAad): Buffer {
  for (const v of [a.orgId, a.connectionId, a.field]) {
    if (v.includes("|")) throw new Error("AAD components may not contain '|'");
  }
  return Buffer.from(`${a.orgId}|${a.connectionId}|${a.field}|${a.version}`, "utf8");
}

export function seal(dek: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (dek.length !== 32) throw new Error("DEK must be 256 bits");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ct]);
}

export function open(dek: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (dek.length !== 32) throw new Error("DEK must be 256 bits");
  if (sealed.length < 1 + NONCE_LEN + TAG_LEN || sealed[0] !== VERSION) throw new Error("Unsupported sealed format");
  const nonce = sealed.subarray(1, 1 + NONCE_LEN);
  const tag = sealed.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
  const ct = sealed.subarray(1 + NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
