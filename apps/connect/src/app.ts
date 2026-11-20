import type { KeyObject } from "node:crypto";
import { RelayonError } from "@relayon/core";
import { verifyRequest, type EncryptingKeyProvider } from "@relayon/crypto";
import { Hono } from "hono";
import type pg from "pg";
import { CREDENTIAL_FIELDS, storeCredential } from "./store.js";

export interface ConnectDeps {
  vault: pg.Pool;
  keyProvider: EncryptingKeyProvider;
  /** Public key of the API service that signs internal requests. */
  apiPublicKey: KeyObject;
}

/**
 * Internal credential capture. The API forwards the secret here (mTLS + a signed request bound to
 * org/connection and the body hash) and never persists it itself. The response holds no secret.
 */
export function createConnectApp(deps: ConnectDeps) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/internal/credentials", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 64 * 1024) return c.json(new RelayonError("RELAYON_INVALID_INPUT", "Body too large").toBody(), 422);
    let claims;
    try {
      claims = verifyRequest(deps.apiPublicKey, c.req.header("x-relayon-internal") ?? "", "connect", Date.now(), raw);
    } catch {
      return c.json(new RelayonError("RELAYON_UNAUTHENTICATED", "Invalid internal request").toBody(), 401);
    }
    if (claims.op !== "store_credential") {
      return c.json(new RelayonError("RELAYON_FORBIDDEN", "Request not valid for this operation").toBody(), 403);
    }
    let body: { fields?: Record<string, unknown>; expires_at?: string | null };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json(new RelayonError("RELAYON_INVALID_INPUT", "Invalid JSON").toBody(), 422);
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.fields ?? {})) {
      if (!(CREDENTIAL_FIELDS as readonly string[]).includes(k) || typeof v !== "string" || v.length > 8192) {
        return c.json(new RelayonError("RELAYON_INVALID_INPUT", `Invalid credential field ${k}`).toBody(), 422);
      }
      fields[k] = v;
    }
    const { credentialId } = await storeCredential(deps.vault, deps.keyProvider, {
      orgId: claims.org_id,
      connectionId: claims.connection_id,
      fields,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    });
    return c.json({ credential_id: credentialId });
  });

  app.onError((_err, c) => c.json(new RelayonError("RELAYON_INTERNAL", "Internal error").toBody(), 500));
  return app;
}
