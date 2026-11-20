/** Connection strings for integration tests. CI sets these; defaults match infra/docker-compose.yml. */
export const TEST_MAIN_OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL ?? "postgres://relayon_owner:relayon_owner@localhost:5432/relayon";
export const TEST_MAIN_APP_URL = process.env.TEST_DATABASE_URL ?? "postgres://relayon_app:relayon_app@localhost:5432/relayon";
export const TEST_MAIN_EXECUTOR_URL = process.env.TEST_EXECUTOR_DATABASE_URL ?? "postgres://relayon_executor_ro:relayon_executor_ro@localhost:5432/relayon";
export const TEST_VAULT_OWNER_URL = process.env.TEST_VAULT_DATABASE_MIGRATE_URL ?? "postgres://relayon_vault:relayon_vault@localhost:5433/relayon_vault";
