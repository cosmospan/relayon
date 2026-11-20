import { generateApiKey } from "@relayon/authz";
import { newId, withTenant } from "@relayon/db";
import pg from "pg";
import { env, hexFile } from "./wiring.js";

/**
 * Creates an org, a project and an API key with full scopes, and prints the key ONCE.
 * For local development and first setup. The key is never stored in plaintext.
 */
const ALL_SCOPES = ["actions:read", "actions:write", "approvals:decide", "undo:force", "policies:write", "connections:write"];

export async function bootstrap(pool: pg.Pool, pepper: Buffer, name: string, scopes = ALL_SCOPES, existing?: { orgId: string; projectId: string }) {
  const orgId = existing?.orgId ?? newId("org");
  const projectId = existing?.projectId ?? newId("project");
  const key = generateApiKey(pepper);
  const keyId = newId("apiKey");
  await withTenant(pool, { orgId }, async (db) => {
    if (!existing) {
      await db.query("insert into orgs(id, name) values ($1, $2)", [orgId, name]);
      await db.query("insert into projects(id, org_id, name) values ($1, $2, $3)", [projectId, orgId, name]);
    }
    await db.query("insert into api_keys(id, org_id, project_id, name, prefix, hash, scopes) values ($1,$2,$3,$4,$5,$6,$7)", [keyId, orgId, projectId, `${name} key`, key.prefix, key.hash, scopes]);
    await db.query("insert into audit_events(org_id, project_id, actor, event, target) values ($1,$2,'system','key.created',$3)", [orgId, projectId, keyId]);
  });
  return { orgId, projectId, keyId, key: key.key };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
  const out = await bootstrap(pool, hexFile(env("API_KEY_PEPPER_FILE")), process.argv[2] ?? "dev");
  console.log(`org:     ${out.orgId}\nproject: ${out.projectId}\napi key: ${out.key}\n(shown once; store it in your agent's secret store)`);
  await pool.end();
}
