# Relayon

The relay between AI agents and the apps they act on. Every agent action is previewed, logged with cost, and either reversible or held for approval.

The full build spec is in [docs/RELAYON_BUILD_SPEC.md](docs/RELAYON_BUILD_SPEC.md). Security notes are in [docs/security/threat-model.md](docs/security/threat-model.md).

## What works today (weeks 1–2 milestone)

- **REST `/v1`** and **MCP `/mcp`** (Streamable HTTP, stateless JSON) with API-key auth.
- **Relay pipeline**: classify → policy → preview (diff) → snapshot → execute / hold / approve → hash-chained ledger.
- **Policies** in YAML or JSON (most restrictive wins, safe expression language, fail closed).
- **Approvals** (the requesting key can't approve its own action) and **hold windows** (BullMQ + a 30 s sweeper, exactly-once).
- **Undo** of one action or a whole run, newest first, with conflict detection and `force`.
- **Security base**: separate vault DB, isolated Executor (the only place credentials are decrypted), envelope encryption, forced Postgres RLS, SSRF-guarded `safeFetch`.
- A **demo connector** (an in-memory fake app) to exercise everything end to end. Real connectors (Linear, Notion, HubSpot, GitHub, Google Sheets) come next.

## Run it locally

```bash
corepack enable && pnpm install
cp .env.example .env && pnpm dev:keys        # local-only keys in .dev-keys/ (gitignored)
docker compose -f infra/docker-compose.yml up -d
pnpm build
pnpm db:migrate                              # main + vault DBs, creates local login roles
pnpm bootstrap                               # prints an org, project and API key (once)
pnpm start:local                             # api :8787, executor :8788, connect :8789, worker
```

Try it (replace `$KEY` with the printed key):

```bash
curl -s localhost:8787/v1/connections -H "Authorization: Bearer $KEY" -H content-type:application/json -d '{"app":"demo"}'
curl -s localhost:8787/v1/actions -H "Authorization: Bearer $KEY" -H content-type:application/json \
  -d '{"tool":"demo.create_record","input":{"title":"Acme"},"run_id":"run-1"}'
curl -s localhost:8787/v1/runs/run-1/undo -X POST -H "Authorization: Bearer $KEY" -H content-type:application/json -d '{}'
```

MCP clients: point them at `http://localhost:8787/mcp` with header `Authorization: Bearer $KEY`.

## Develop

```bash
pnpm turbo run lint typecheck test build     # integration tests need the Postgres containers
pnpm test:security                           # tenant isolation, vault, crypto, SSRF, executor
```

Every workspace exposes `build`, `dev`, `lint`, `typecheck` and `test`.
