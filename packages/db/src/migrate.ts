import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Minimal forward-only migration runner. Runs as the OWNER role (CI/CD only), inside an advisory
 * lock so concurrent runners (parallel test workers, multiple deploys) serialise.
 */
export async function runMigrations(connectionString: string, dir: string, lockKey: number): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [lockKey]);
    await client.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was edited after being applied (forward-only)`);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(name, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [lockKey]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

/**
 * Creates LOGIN users for local development and tests, as members of the NOLOGIN roles the
 * migrations define. Refuses to run in production: real deployments provision users separately.
 */
export async function ensureDevLogin(ownerUrl: string, user: string, password: string, memberOf: string): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("ensureDevLogin refuses to run in production");
  if (!/^[a-z_][a-z0-9_]*$/.test(user) || !/^[a-z_][a-z0-9_]*$/.test(memberOf)) throw new Error("invalid role name");
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(4242)");
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [user]);
    if (exists.rowCount === 0) {
      await client.query(`create role ${user} login nosuperuser nobypassrls password '${password.replace(/'/g, "''")}'`);
    }
    await client.query(`grant ${memberOf} to ${user}`);
  } finally {
    await client.query("select pg_advisory_unlock(4242)").catch(() => undefined);
    await client.end();
  }
}
