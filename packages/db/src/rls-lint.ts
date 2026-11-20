import pg from "pg";

/** Tables exempt from tenant RLS because they hold no tenant data. Keep this list tiny. */
export const RLS_EXEMPT = new Set(["schema_migrations", "tools"]);

export interface RlsLintIssue {
  table: string;
  problem: string;
}

/**
 * Migration lint (§11.5): every public table must have RLS enabled AND forced, with at least one
 * policy, unless explicitly exempt.
 */
export async function lintRls(client: pg.ClientBase): Promise<RlsLintIssue[]> {
  const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
    order by c.relname`);
  const issues: RlsLintIssue[] = [];
  for (const r of rows) {
    if (RLS_EXEMPT.has(r.relname)) continue;
    if (!r.relrowsecurity) issues.push({ table: r.relname, problem: "RLS not enabled" });
    if (!r.relforcerowsecurity) issues.push({ table: r.relname, problem: "RLS not forced" });
    if (r.policies === 0) issues.push({ table: r.relname, problem: "no policy" });
  }
  return issues;
}
