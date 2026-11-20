import { createHash, randomBytes, sign, verify, type KeyObject } from "node:crypto";

/**
 * Signed internal requests across trust boundaries (§11.2): API/Worker → Executor, API → Connect.
 * Ed25519 over a canonical JSON payload, ≤30 s lifetime, random nonce (single use is enforced by the
 * receiver). Token = base64url(payload) + "." + base64url(signature).
 */
export interface SignedClaims {
  v: 1;
  aud: "executor" | "connect";
  org_id: string;
  project_id: string;
  connection_id: string;
  op: string;
  action_id?: string;
  tool_id?: string;
  input_hash?: string;
  body_sha256?: string;
  exp: number;
  nonce: string;
}

const MAX_LIFETIME_S = 30;

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function signRequest(privateKey: KeyObject, claims: Omit<SignedClaims, "v" | "exp" | "nonce">, now = Date.now()): string {
  const full: SignedClaims = { v: 1, ...claims, exp: Math.floor(now / 1000) + MAX_LIFETIME_S, nonce: randomBytes(16).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(full));
  const sig = sign(null, payload, privateKey);
  return `${payload.toString("base64url")}.${sig.toString("base64url")}`;
}

export class SignedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedRequestError";
  }
}

export function verifyRequest(publicKey: KeyObject, token: string, aud: SignedClaims["aud"], now = Date.now()): SignedClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new SignedRequestError("malformed token");
  const payload = Buffer.from(parts[0]!, "base64url");
  const sig = Buffer.from(parts[1]!, "base64url");
  if (!verify(null, payload, publicKey, sig)) throw new SignedRequestError("bad signature");
  let claims: SignedClaims;
  try {
    claims = JSON.parse(payload.toString("utf8")) as SignedClaims;
  } catch {
    throw new SignedRequestError("malformed payload");
  }
  if (claims.v !== 1 || claims.aud !== aud) throw new SignedRequestError("wrong audience");
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < nowS) throw new SignedRequestError("expired");
  if (claims.exp > nowS + MAX_LIFETIME_S + 5) throw new SignedRequestError("lifetime too long");
  for (const k of ["org_id", "project_id", "connection_id", "op", "nonce"] as const) {
    if (typeof claims[k] !== "string" || !claims[k]) throw new SignedRequestError(`missing ${k}`);
  }
  return claims;
}
