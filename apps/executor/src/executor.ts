import type { KeyObject } from "node:crypto";
import { RelayonError } from "@relayon/core";
import { DekCache, aadFor, open, verifyRequest, type SignedClaims } from "@relayon/crypto";
import { withTenant } from "@relayon/db";
import { redact } from "@relayon/net";
import { loadCredential, recordDecrypt, type DecryptPurpose } from "@relayon/vault-db";
import type pg from "pg";

/** Plaintext credential handed to a connector for ONE outbound request. Never returned or logged. */
export interface Credential {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly apiKey?: string;
}

export interface ToolInvocation {
  op: string;
  toolId: string;
  actionId: string;
  connectionId: string;
  input: unknown;
  /** Extra non-secret data from the relay engine (e.g. a stored snapshot for undo). */
  params: unknown;
  credential: Credential | null;
}

/** Connector runtime plugged in by packages/connector-kit. Runs only inside the Executor. */
export interface ToolRuntime {
  run(inv: ToolInvocation): Promise<unknown>;
}

export interface ExecutorDeps {
  /** Main DB, read-only role, used to re-check the action itself (§11.2). */
  mainRo: pg.Pool;
  /** Vault DB, executor role. */
  vault: pg.Pool;
  dekCache: DekCache;
  /** Public keys of services allowed to sign exec requests (API, Worker). */
  trustedSigners: readonly KeyObject[];
  runtime: ToolRuntime;
  instanceId: string;
}

/**
 * Which action status each op requires. Writes (`snapshot`, `execute`) only run on an action the
 * state machine has moved to `executing`; `undo_check` reads the original, succeeded action.
 */
const OP_STATUS: Record<string, readonly string[]> = {
  preview: ["received", "previewed"],
  snapshot: ["executing"],
  execute: ["executing"],
  undo_check: ["succeeded"],
};

const PURPOSE: Record<string, DecryptPurpose> = {
  preview: "execute", snapshot: "execute", execute: "execute", undo_check: "undo",
};

function verifyAny(signers: readonly KeyObject[], token: string): SignedClaims {
  let last: unknown;
  for (const k of signers) {
    try {
      return verifyRequest(k, token, "executor");
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no signers");
}

interface ActionCheckRow {
  id: string; status: string; tool_id: string; connection_id: string | null; project_id: string; input: unknown; input_hash: Buffer;
}

/**
 * Handles one signed exec request end to end. Never trusts the caller's claims alone: the action is
 * re-read from the main DB under the claimed tenant and must match org, project, connection, tool,
 * input hash and status. The decrypted credential lives only inside this function.
 */
export async function handleExec(deps: ExecutorDeps, token: string, params: unknown): Promise<{ result: unknown }> {
  let claims: SignedClaims;
  try {
    claims = verifyAny(deps.trustedSigners, token);
  } catch {
    throw new RelayonError("RELAYON_UNAUTHENTICATED", "Invalid exec request");
  }
  const allowed = OP_STATUS[claims.op];
  if (!allowed || !claims.action_id || !claims.tool_id || !claims.input_hash) {
    throw new RelayonError("RELAYON_FORBIDDEN", "Exec request not valid");
  }

  const check = await withTenant(deps.mainRo, { orgId: claims.org_id }, async (db) => {
    const a = await db.query<ActionCheckRow>(
      "select id, status, tool_id, connection_id, project_id, input, input_hash from actions where id = $1",
      [claims.action_id],
    );
    const action = a.rows[0];
    if (!action) return null;
    const c = action.connection_id
      ? (await db.query<{ auth_type: string; status: string }>("select auth_type, status from connections where id = $1", [action.connection_id])).rows[0]
      : undefined;
    return { action, connection: c };
  });
  const action = check?.action;
  if (
    !action ||
    action.project_id !== claims.project_id ||
    action.tool_id !== claims.tool_id ||
    (action.connection_id ?? "none") !== claims.connection_id ||
    action.input_hash.toString("hex") !== claims.input_hash ||
    !allowed.includes(action.status)
  ) {
    throw new RelayonError("RELAYON_FORBIDDEN", "Exec request does not match the action");
  }
  if (check.connection && check.connection.status !== "active") {
    throw new RelayonError(check.connection.status === "expired" ? "RELAYON_CONNECTION_EXPIRED" : "RELAYON_CONNECTION_MISSING", "Connection is not active");
  }

  // Burn the nonce (and log the decrypt) before touching any secret. Replay → rejected.
  const fresh = await recordDecrypt(deps.vault, {
    orgId: claims.org_id,
    connectionId: claims.connection_id,
    actionId: claims.action_id,
    purpose: PURPOSE[claims.op]!,
    nonce: claims.nonce,
    executorInstance: deps.instanceId,
  });
  if (!fresh) throw new RelayonError("RELAYON_FORBIDDEN", "Exec request replayed");

  const secrets: string[] = [];
  let credential: Credential | null = null;
  if (action.connection_id && check.connection && check.connection.auth_type !== "none") {
    const loaded = await loadCredential(deps.vault, claims.org_id, claims.connection_id);
    if (!loaded) throw new RelayonError("RELAYON_CONNECTION_MISSING", "No credential for connection");
    const { cred, key } = loaded;
    const dek = await deps.dekCache.get(key.id, key.wrapped_dek, key.kms_key_arn, key.context);
    const dec = (field: string, ct: Buffer | null) => {
      if (!ct) return undefined;
      const v = open(dek, ct, aadFor({ orgId: claims.org_id, connectionId: claims.connection_id, field, version: cred.field_version })).toString("utf8");
      secrets.push(v);
      return v;
    };
    credential = Object.freeze({
      accessToken: dec("access_token", cred.access_token_enc),
      refreshToken: dec("refresh_token", cred.refresh_token_enc),
      apiKey: dec("api_key", cred.api_key_enc),
    });
  }

  try {
    const result = await deps.runtime.run({ op: claims.op, toolId: claims.tool_id, actionId: action.id, connectionId: claims.connection_id, input: action.input, params, credential });
    // Redact before anything leaves the vault zone (§11.4 step 4), including exact secret values.
    return { result: redact(result, { secrets }) };
  } catch (err) {
    if (err instanceof RelayonError) {
      throw new RelayonError(err.code, redact(err.message, { secrets }), { details: err.details ? redact(err.details, { secrets }) : undefined });
    }
    throw new RelayonError("RELAYON_UPSTREAM_ERROR", "Connector failed");
  } finally {
    // Drop references to plaintext as soon as the call ends.
    secrets.length = 0;
  }
}
