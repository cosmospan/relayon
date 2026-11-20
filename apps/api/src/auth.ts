import { parseApiKey, verifyApiKey, type Kind, type TenantContext } from "@relayon/authz";
import { RelayonError } from "@relayon/core";
import { withTenant } from "@relayon/db";
import type pg from "pg";

interface KeyRow {
  id: string; org_id: string; project_id: string; hash: Buffer; scopes: string[]; agent_name: string | null;
  allowed_apps: string[] | null; allowed_tools: string[] | null; max_kind: Kind | null; allowed_end_users: string[] | null;
  expires_at: Date | null; revoked_at: Date | null;
}

/**
 * Resolves the tenant context from `Authorization: Bearer rl_live_…` ONLY (§11.5). Shape and
 * checksum are checked before any DB call; the lookup goes through a security-definer function.
 */
export async function authenticate(pool: pg.Pool, pepper: Buffer, authorization: string | undefined): Promise<TenantContext> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const key = m?.[1];
  const parsed = key ? parseApiKey(key) : null;
  if (!key || !parsed) throw new RelayonError("RELAYON_UNAUTHENTICATED", "Missing or invalid API key");
  const row = (await pool.query<KeyRow>("select * from relayon_auth_lookup_api_key($1)", [parsed.prefix])).rows[0];
  if (!row || !verifyApiKey(pepper, key, row.hash)) throw new RelayonError("RELAYON_UNAUTHENTICATED", "Missing or invalid API key");
  if (row.revoked_at || (row.expires_at && row.expires_at.getTime() <= Date.now())) throw new RelayonError("RELAYON_UNAUTHENTICATED", "API key revoked or expired");
  const ctx: TenantContext = {
    orgId: row.org_id,
    projectId: row.project_id,
    principal: {
      type: "api_key", keyId: row.id, scopes: row.scopes, agentName: row.agent_name, allowedApps: row.allowed_apps,
      allowedTools: row.allowed_tools, maxKind: row.max_kind, allowedEndUsers: row.allowed_end_users,
    },
  };
  // Best effort, off the request path's critical section.
  void withTenant(pool, { orgId: ctx.orgId }, (db) => db.query("update api_keys set last_used_at = now() where id = $1", [row.id])).catch(() => undefined);
  return ctx;
}
