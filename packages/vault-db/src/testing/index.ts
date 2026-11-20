import { ensureDevLogin, runMigrations } from "@relayon/db";
import { TEST_VAULT_OWNER_URL } from "@relayon/db/testing";
import pg from "pg";
import { VAULT_MIGRATIONS_DIR, VAULT_MIGRATION_LOCK } from "../index.js";

export function vaultUrlFor(user: string, password: string): string {
  const u = new URL(TEST_VAULT_OWNER_URL);
  u.username = user;
  u.password = password;
  return u.toString();
}

export async function setupVaultDb() {
  await runMigrations(TEST_VAULT_OWNER_URL, VAULT_MIGRATIONS_DIR, VAULT_MIGRATION_LOCK);
  await ensureDevLogin(TEST_VAULT_OWNER_URL, "relayon_executor", "relayon_executor", "relayon_executor_role");
  await ensureDevLogin(TEST_VAULT_OWNER_URL, "relayon_connect", "relayon_connect", "relayon_connect_role");
  return {
    owner: new pg.Pool({ connectionString: TEST_VAULT_OWNER_URL, max: 2 }),
    executor: new pg.Pool({ connectionString: vaultUrlFor("relayon_executor", "relayon_executor"), max: 2 }),
    connect: new pg.Pool({ connectionString: vaultUrlFor("relayon_connect", "relayon_connect"), max: 2 }),
  };
}
