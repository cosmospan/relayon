/**
 * KeyProvider (§11.4). Capabilities are split so that a service can be given only what it needs:
 * - apps/connect gets an EncryptingKeyProvider (GenerateDataKey only, no Decrypt);
 * - apps/executor gets a DecryptingKeyProvider (the only holder of Decrypt).
 * Every call carries an encryption context; a wrapped DEK cannot be unwrapped under another context.
 */
export type EncryptionContext = Readonly<Record<string, string>>;

export interface DataKey {
  /** 32-byte plaintext DEK. Zero it after use with `zeroize`. */
  plaintext: Buffer;
  /** Opaque wrapped DEK to store in the vault DB. */
  wrapped: Buffer;
  /** KEK reference (e.g. KMS key ARN) used to wrap it. */
  kekRef: string;
}

export interface EncryptingKeyProvider {
  readonly kind: string;
  generateDataKey(context: EncryptionContext): Promise<DataKey>;
}

export interface DecryptingKeyProvider {
  readonly kind: string;
  decryptDataKey(wrapped: Buffer, kekRef: string, context: EncryptionContext): Promise<Buffer>;
}

export type KeyProvider = EncryptingKeyProvider & DecryptingKeyProvider;

export function zeroize(buf: Buffer): void {
  buf.fill(0);
}

/** Canonical, order-independent serialisation of a context (used as AAD by the dev provider). */
export function canonicalContext(ctx: EncryptionContext): string {
  return JSON.stringify(Object.keys(ctx).sort().map((k) => [k, ctx[k]]));
}
