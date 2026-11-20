# Relayon threat model

Source of truth for attackers and STRIDE per component: [build spec §11.3](../RELAYON_BUILD_SPEC.md). This file records **what is actually implemented** and what is still open. Update it at every milestone (security gates in §14).

_Last updated: core relay PR (engine, REST + MCP, policy, ledger, undo)._

## Trust boundaries as built

| Boundary | Implemented by | Status |
|---|---|---|
| 1 → 2 Edge → core: tenant context only from the credential | `packages/authz` (API key format, HMAC hash, scoping), `packages/db` `withTenant` | Done: `apps/api/src/auth.ts` derives org/project from the key; request bodies never carry `org_id` |
| Main DB tenant isolation | `packages/db/migrations/0001_init.sql`: RLS `ENABLE` + `FORCE` + `tenant_isolation` policy on every table with `org_id`, plus `orgs` and `users`; app role is non-owner and `NOBYPASSRLS`; migration lint `lintRls` | Done, tested |
| Pre-auth key lookup | `relayon_auth_lookup_api_key(prefix)` security-definer function and an owner-only `auth_lookup` policy; app role cannot read `api_keys` without tenant context | Done, tested |
| Ledger append-only | No `DELETE` grant on `actions` to the app; trigger rejects changes to immutable columns | Done, tested |
| 2 → 3 Core → vault zone | `packages/crypto` signed requests (Ed25519, ≤30 s, random nonce; request bodies to Connect are covered by the signature itself, so no digest of a secret-bearing body is ever sent); `apps/executor` re-reads the action under RLS through a read-only role and checks org, project, connection, tool, input hash and status; nonce burnt in `exec_nonces` | Done, tested |
| Vault DB separation | `packages/vault-db`: separate DB; Connect role can insert but not select ciphertext; Executor role can select but not delete; `decrypt_log` append-only via trigger; forced RLS in the vault too | Done, tested |
| 3 → 4 KMS | `KeyProvider` split into `EncryptingKeyProvider` (Connect) and `DecryptingKeyProvider` (Executor); AWS KMS adapters pass `EncryptionContext {org_id, connection_id, purpose}`; dev provider refuses production | Code done; **KMS key policy and IAM roles not yet provisioned** (no cloud account chosen) |
| Field encryption | AES-256-GCM, random 96-bit nonce, AAD `org_id|connection_id|field|version` | Done, tested (AAD swap, tamper) |
| Results leaving the Executor | `packages/net` `redact`: sensitive keys, token-shaped values, signed-URL params, and exact plaintext secret values | Done, tested with a connector that tries to leak |
| 3 → Internet | `packages/net` `safeFetch`: https only, port 443, allowlist, every resolved IP checked against §11.9 ranges (incl. IPv4-mapped/NAT64), socket pinned to the checked IP, redirects off (max 3 re-checked), 10 MB cap, 5 s/30 s timeouts; Semgrep bans raw `fetch` elsewhere | Done, SSRF corpus tested; Smokescreen in docker-compose |

| Policy expressions | `packages/policy/src/expr.ts`: hand-written lexer + Pratt parser + interpreter over a fixed grammar; no `eval`/`Function`/`vm`; `__proto__`/`prototype`/`constructor` rejected; any evaluation error fails closed (`block`) | Done, tested |
| Snapshots at rest | `packages/engine` `SnapshotSealer`: AES-256-GCM with AAD `snapshot|org|action|slot`, key from `SNAPSHOT_KEY_FILE` | Done; **key is a single local key, not KMS-wrapped yet** |
| Sweepers (holds, approval expiry) | `relayon_due_holds` / `relayon_due_approval_expiries` security-definer functions return only ids + org ids; the worker then re-enters `withTenant` per action | Done, tested |
| Ledger integrity | `packages/ledger`: hash chain per project, `pg_advisory_xact_lock` per project, guarded transitions `WHERE status = ANY($expected)` | Done, tested (`verifyChain`) |
| MCP endpoint | `apps/api/src/mcp.ts`: hand-rolled stateless Streamable HTTP (JSON responses only), Origin allowlist, same API-key auth and scopes as REST; protocol 2026-07-28 envelope enforced (MCP-Protocol-Version / Mcp-Method / Mcp-Name must match the body, else 400) plus the 2025 dialects | Done; **not yet tested against third-party MCP clients** |

## Design decisions to review

1. **One DEK per credential write, not one per org.** §11.4 asks for per-org DEKs *and* an encrypt-only Connect service. Those conflict: encrypting under an existing wrapped DEK needs `Decrypt`. Connect therefore calls `GenerateDataKey` for each credential write, with the encryption context bound to org and connection. Cost: one KMS call per connection write (rare). The Executor caches unwrapped DEKs ≤ 5 min.
2. **Raw SQL migrations instead of a Drizzle schema** for this milestone. RLS, policies, triggers and grants are SQL anyway; a typed Drizzle schema can be generated from the DB later.
3. **Executor reads the action input from the main DB** instead of trusting the caller, so an approved input can't be swapped (the signed `input_hash` must also match).

4. **Snapshot key is local, not KMS.** Snapshots contain pre-change resource state (may include customer data, never credentials). For the MVP they are sealed with one service key; move to KMS-wrapped per-org keys before GA.
5. **MCP server is hand-rolled** rather than using the official SDK, to keep it stateless and to reuse the REST auth path. Revisit if session features are needed.

## Open items before Security Gate 1

- [ ] KMS policy test in a staging cloud account (only the Executor role can `Decrypt`).
- [ ] Planted-fake-token grep across logs and Redis (the Executor test covers responses only).
- [ ] mTLS between API/Worker and Executor/Connect; network policy so only they reach the vault DB.
- [ ] Executor process hardening: non-root, read-only FS, no core dumps.
- [ ] Security prompt S1 run and findings fixed.
- [ ] Snapshot key moved to KMS-wrapped per-org DEKs.
- [ ] Interop test of `/mcp` with Claude, Cursor and the MCP Inspector.
