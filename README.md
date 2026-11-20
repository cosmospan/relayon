# Relayon

The relay between AI agents and the apps they act on. Every agent action is previewed, logged with cost, and either reversible or held for approval.

The full build spec is in [docs/RELAYON_BUILD_SPEC.md](docs/RELAYON_BUILD_SPEC.md).

## Local setup

```bash
corepack enable && pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d   # Postgres 16 (main + vault), Redis 7, MinIO, egress proxy
pnpm build && pnpm test
pnpm dev                                           # api :8787, worker, dashboard :3000
```

Every workspace exposes `build`, `dev`, `lint`, `typecheck` and `test`.
