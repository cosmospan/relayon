import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./repo.js";

export const VAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const VAULT_MIGRATION_LOCK = 7_002;
