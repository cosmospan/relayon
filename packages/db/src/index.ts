import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./ids.js";
export * from "./migrate.js";
export * from "./rls-lint.js";
export * from "./tenant.js";

/** Absolute path of the main DB migrations directory. */
export const MAIN_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const MAIN_MIGRATION_LOCK = 7_001;
