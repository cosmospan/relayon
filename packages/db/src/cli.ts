import { MAIN_MIGRATIONS_DIR, MAIN_MIGRATION_LOCK, ensureDevLogin, runMigrations } from "./index.js";

const url = process.env.DATABASE_MIGRATE_URL;
if (!url) throw new Error("DATABASE_MIGRATE_URL (owner role) is required");
const applied = await runMigrations(url, MAIN_MIGRATIONS_DIR, MAIN_MIGRATION_LOCK);
console.log(JSON.stringify({ msg: "main migrations applied", applied }));
if (process.argv.includes("--dev-roles")) {
  await ensureDevLogin(url, "relayon_app", "relayon_app", "relayon_app_role");
  await ensureDevLogin(url, "relayon_executor_ro", "relayon_executor_ro", "relayon_executor_ro_role");
  console.log(JSON.stringify({ msg: "dev login roles ready" }));
}
