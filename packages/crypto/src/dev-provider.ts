import { randomBytes } from "node:crypto";
import { open, seal } from "./aead.js";
import { canonicalContext, type DataKey, type EncryptionContext, type KeyProvider } from "./key-provider.js";

/**
 * Local development KeyProvider: wraps DEKs with a 256-bit master key using AES-256-GCM, with the
 * canonical encryption context as AAD. Refuses to construct when NODE_ENV=production.
 */
export class DevKeyProvider implements KeyProvider {
  readonly kind = "dev";
  readonly #master: Buffer;
  readonly #ref: string;

  constructor(masterKey: Buffer, ref = "dev:local") {
    if (process.env.NODE_ENV === "production") throw new Error("DevKeyProvider refuses to run with NODE_ENV=production");
    if (masterKey.length !== 32) throw new Error("dev master key must be 32 bytes");
    this.#master = Buffer.from(masterKey);
    this.#ref = ref;
  }

  static fromHex(hex: string): DevKeyProvider {
    if (!/^[0-9a-f]{64}$/i.test(hex.trim())) throw new Error("dev master key must be 64 hex chars");
    return new DevKeyProvider(Buffer.from(hex.trim(), "hex"));
  }

  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const wrapped = seal(this.#master, plaintext, Buffer.from(canonicalContext(context)));
    return { plaintext, wrapped, kekRef: this.#ref };
  }

  async decryptDataKey(wrapped: Buffer, kekRef: string, context: EncryptionContext): Promise<Buffer> {
    if (kekRef !== this.#ref) throw new Error("unknown KEK reference");
    return open(this.#master, wrapped, Buffer.from(canonicalContext(context)));
  }
}
