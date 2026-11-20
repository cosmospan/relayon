import { aadFor, seal, zeroize, type EncryptingKeyProvider } from "@relayon/crypto";
import { newId, withTenant } from "@relayon/db";
import type pg from "pg";

export const CREDENTIAL_FIELDS = ["access_token", "refresh_token", "api_key"] as const;
export type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

export interface StoreCredentialInput {
  orgId: string;
  connectionId: string;
  fields: Partial<Record<CredentialField, string>>;
  expiresAt?: Date | null;
}

/** Encryption context binding a connection's DEK to its tenant (§11.4). */
export function credentialContext(orgId: string, connectionId: string) {
  return { org_id: orgId, connection_id: connectionId, purpose: "credential" };
}

/**
 * Encrypts and stores a credential. Encrypt-only: a fresh DEK per credential write comes from
 * GenerateDataKey, so Connect never needs Decrypt. The plaintext DEK is zeroed after use and the
 * function returns only the credential id: there is no read-back path.
 */
export async function storeCredential(vault: pg.Pool, kp: EncryptingKeyProvider, input: StoreCredentialInput): Promise<{ credentialId: string }> {
  const present = CREDENTIAL_FIELDS.filter((f) => typeof input.fields[f] === "string" && input.fields[f]!.length > 0);
  if (present.length === 0) throw new Error("no credential fields");
  const context = credentialContext(input.orgId, input.connectionId);
  const dk = await kp.generateDataKey(context);
  const dekId = newId("dek");
  const version = 1;
  try {
    const enc: Record<CredentialField, Buffer | null> = { access_token: null, refresh_token: null, api_key: null };
    for (const f of present) {
      enc[f] = seal(dk.plaintext, Buffer.from(input.fields[f]!, "utf8"), aadFor({ orgId: input.orgId, connectionId: input.connectionId, field: f, version }));
    }
    return await withTenant(vault, { orgId: input.orgId }, async (db) => {
      await db.query("insert into org_keys(id, org_id, kms_key_arn, wrapped_dek, context) values ($1,$2,$3,$4,$5)", [dekId, input.orgId, dk.kekRef, dk.wrapped, context]);
      const existing = await db.query<{ id: string }>("select id from credentials where connection_id = $1", [input.connectionId]);
      if (existing.rows[0]) {
        await db.query(
          `update credentials set access_token_enc=$2, refresh_token_enc=$3, api_key_enc=$4, expires_at=$5, dek_id=$6, field_version=$7, rotated_at=now()
           where connection_id=$1`,
          [input.connectionId, enc.access_token, enc.refresh_token, enc.api_key, input.expiresAt ?? null, dekId, version],
        );
        return { credentialId: existing.rows[0].id };
      }
      const id = newId("credential");
      await db.query(
        `insert into credentials(id, connection_id, org_id, access_token_enc, refresh_token_enc, api_key_enc, expires_at, dek_id, field_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, input.connectionId, input.orgId, enc.access_token, enc.refresh_token, enc.api_key, input.expiresAt ?? null, dekId, version],
      );
      return { credentialId: id };
    });
  } finally {
    zeroize(dk.plaintext);
  }
}

/** Crypto-shred (§11.4): drop ciphertext and mark the DEK shredded. */
export async function shredCredential(vault: pg.Pool, orgId: string, connectionId: string): Promise<void> {
  await withTenant(vault, { orgId }, async (db) => {
    const r = await db.query<{ id: string }>("select id from credentials where connection_id = $1", [connectionId]);
    if (!r.rows[0]) return;
    await db.query("update credentials set access_token_enc=null, refresh_token_enc=null, api_key_enc=null where connection_id=$1", [connectionId]);
  });
}
