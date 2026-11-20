import pg from "pg";

export interface TenantScope {
  orgId: string;
  projectId?: string;
}

const ID_RE = /^[a-z]+_[0-9a-z]{26}$/;

/**
 * Runs `fn` in a transaction whose `app.org_id` is set (transaction-local, safe with transaction
 * pooling). RLS policies filter on it, so a missing setting yields zero rows (§11.5).
 * The scope MUST come from the authenticated credential, never from a request body.
 */
export async function withTenant<T>(pool: pg.Pool, scope: TenantScope, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!ID_RE.test(scope.orgId)) throw new Error("withTenant: invalid org id");
  if (scope.projectId !== undefined && !ID_RE.test(scope.projectId)) throw new Error("withTenant: invalid project id");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [scope.orgId]);
    if (scope.projectId) await client.query("select set_config('app.project_id', $1, true)", [scope.projectId]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** For the narrow pre-auth path (API key lookup by prefix through the SECURITY DEFINER function). */
export async function withoutTenant<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
