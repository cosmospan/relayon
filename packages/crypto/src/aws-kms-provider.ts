import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import type { DataKey, DecryptingKeyProvider, EncryptingKeyProvider, EncryptionContext } from "./key-provider.js";

type KmsLike = Pick<KMSClient, "send">;

/**
 * AWS KMS adapter. Deploy two instances with different IAM roles: Connect's role may only call
 * GenerateDataKey; the Executor's role may call Decrypt. The key policy enforces it (§11.2).
 */
export class AwsKmsEncryptingProvider implements EncryptingKeyProvider {
  readonly kind = "aws-kms";
  constructor(private readonly kms: KmsLike, private readonly keyArn: string) {}

  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const out = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyArn, KeySpec: "AES_256", EncryptionContext: { ...context } }));
    if (!out.Plaintext || !out.CiphertextBlob || !out.KeyId) throw new Error("KMS GenerateDataKey returned no key");
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob), kekRef: out.KeyId };
  }
}

export class AwsKmsDecryptingProvider implements DecryptingKeyProvider {
  readonly kind = "aws-kms";
  constructor(private readonly kms: KmsLike) {}

  async decryptDataKey(wrapped: Buffer, kekRef: string, context: EncryptionContext): Promise<Buffer> {
    const out = await this.kms.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: kekRef, EncryptionContext: { ...context } }));
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    return Buffer.from(out.Plaintext);
  }
}
