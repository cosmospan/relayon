import type { DecryptingKeyProvider, EncryptionContext } from "./key-provider.js";
import { canonicalContext, zeroize } from "./key-provider.js";

/** In-process DEK cache for the Executor: at most `ttlMs` (default 5 min) per wrapped key (§11.4). */
export class DekCache {
  readonly #entries = new Map<string, { dek: Buffer; expires: number }>();
  constructor(private readonly provider: DecryptingKeyProvider, private readonly ttlMs = 5 * 60_000, private readonly now = () => Date.now()) {}

  async get(dekId: string, wrapped: Buffer, kekRef: string, context: EncryptionContext): Promise<Buffer> {
    const key = `${dekId}:${canonicalContext(context)}`;
    const hit = this.#entries.get(key);
    if (hit && hit.expires > this.now()) return hit.dek;
    if (hit) {
      zeroize(hit.dek);
      this.#entries.delete(key);
    }
    const dek = await this.provider.decryptDataKey(wrapped, kekRef, context);
    this.#entries.set(key, { dek, expires: this.now() + this.ttlMs });
    return dek;
  }

  clear(): void {
    for (const e of this.#entries.values()) zeroize(e.dek);
    this.#entries.clear();
  }
}
