import { ensureDevLogin, runMigrations } from "@relayon/db";
import { VAULT_MIGRATIONS_DIR, VAULT_MIGRATION_LOCK } from "./index.js";

const url = process.env.VAULT_DATABASE_MIGRATE_URL;
if (!url) throw new Error("VAULT_DATABASE_MIGRATE_URL (vault owner role) is required");
const applied = await runMigrations(url, VAULT_MIGRATIONS_DIR, VAULT_MIGRATION_LOCK);
console.log(JSON.stringify({ msg: "vault migrations applied", applied }));
if (process.argv.includes("--dev-roles")) {
  await ensureDevLogin(url, "relayon_executor", "relayon_executor", "relayon_executor_role");
  await ensureDevLogin(url, "relayon_connect", "relayon_connect", "relayon_connect_role");
}
