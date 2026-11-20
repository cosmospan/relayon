import pg from "pg";
import { newId } from "../ids.js";
import { MAIN_MIGRATIONS_DIR, MAIN_MIGRATION_LOCK } from "../index.js";
import { ensureDevLogin, runMigrations } from "../migrate.js";
import { withTenant } from "../tenant.js";
import { TEST_MAIN_APP_URL, TEST_MAIN_EXECUTOR_URL, TEST_MAIN_OWNER_URL } from "./env.js";

export * from "./env.js";

/** Migrates the main test DB and returns pools for the owner, app and executor-ro roles. */
export async function setupMainDb() {
  await runMigrations(TEST_MAIN_OWNER_URL, MAIN_MIGRATIONS_DIR, MAIN_MIGRATION_LOCK);
  await ensureDevLogin(TEST_MAIN_OWNER_URL, "relayon_app", "relayon_app", "relayon_app_role");
  await ensureDevLogin(TEST_MAIN_OWNER_URL, "relayon_executor_ro", "relayon_executor_ro", "relayon_executor_ro_role");
  return {
    owner: new pg.Pool({ connectionString: TEST_MAIN_OWNER_URL, max: 4 }),
    app: new pg.Pool({ connectionString: TEST_MAIN_APP_URL, max: 4 }),
    executor: new pg.Pool({ connectionString: TEST_MAIN_EXECUTOR_URL, max: 2 }),
  };
}

/** Creates an org + project as the owner role (still under RLS: FORCE applies to the owner too). */
export async function createTenant(owner: pg.Pool, name = "test") {
  const orgId = newId("org");
  const projectId = newId("project");
  await withTenant(owner, { orgId }, async (db) => {
    await db.query("insert into orgs(id, name) values ($1, $2)", [orgId, name]);
    await db.query("insert into projects(id, org_id, name) values ($1, $2, $3)", [projectId, orgId, name]);
  });
  return { orgId, projectId };
}
