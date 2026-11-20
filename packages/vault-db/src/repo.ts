import { withTenant } from "@relayon/db";
import type pg from "pg";

export interface CredentialRow {
  id: string;
  connection_id: string;
  org_id: string;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  api_key_enc: Buffer | null;
  field_version: number;
  expires_at: Date | null;
  dek_id: string;
}

export interface OrgKeyRow {
  id: string;
  org_id: string;
  kms_key_arn: string;
  wrapped_dek: Buffer;
  context: Record<string, string>;
  status: string;
}

/** Executor-side reads (relayon_executor_role). */
export async function loadCredential(pool: pg.Pool, orgId: string, connectionId: string): Promise<{ cred: CredentialRow; key: OrgKeyRow } | null> {
  return withTenant(pool, { orgId }, async (db) => {
    const c = await db.query<CredentialRow>("select * from credentials where connection_id = $1", [connectionId]);
    const cred = c.rows[0];
    if (!cred) return null;
    const k = await db.query<OrgKeyRow>("select * from org_keys where id = $1 and status = 'active'", [cred.dek_id]);
    const key = k.rows[0];
    if (!key) return null;
    return { cred, key };
  });
}

export type DecryptPurpose = "execute" | "refresh" | "undo" | "revoke";

/** Burns the nonce and writes decrypt_log in one transaction. Returns false on replay. */
export async function recordDecrypt(
  pool: pg.Pool,
  e: { orgId: string; connectionId: string; actionId: string | null; purpose: DecryptPurpose; nonce: string; executorInstance: string },
): Promise<boolean> {
  try {
    await withTenant(pool, { orgId: e.orgId }, async (db) => {
      await db.query("insert into exec_nonces(nonce, org_id) values ($1, $2)", [e.nonce, e.orgId]);
      await db.query(
        "insert into decrypt_log(org_id, connection_id, action_id, purpose, executor_instance) values ($1,$2,$3,$4,$5)",
        [e.orgId, e.connectionId, e.actionId, e.purpose, e.executorInstance],
      );
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return false;
    throw err;
  }
}
