# Relayon

Read docs/RELAYON_BUILD_SPEC.md before any task, especially "Security principles" and §11. Follow its stack, layout, schema and error codes.

Security rules are non-negotiable:
- Never add a code path that returns or logs a decrypted credential. Only apps/executor may decrypt.
- Every DB access goes through the tenant context. Never accept org_id from request bodies.
- Every outbound fetch uses packages/net `safeFetch`.
- No eval / Function / vm / dynamic import of input.
- Never commit secrets, and never paste real keys into chat.

Work on a feature branch and open a PR; do not push to main.
At the end of every task, list security-relevant changes and any UNVERIFIED assumptions.
