/**
 * Redactor (§11.4 step 4): removes anything that looks like a credential before data leaves the
 * Executor, is logged, or is stored. Known plaintext secrets are scrubbed by exact value too.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|api[_-]?key|apikey|cookie|set-cookie|private[_-]?key|session)($|[_-])/i;

const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\brl_(?:live|test)_[A-Za-z0-9_]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bsecret_[A-Za-z0-9]{20,}/g,
  /\bntn_[A-Za-z0-9]{20,}/g,
  /\bpat-[a-z]{2}\d?-[0-9a-f-]{20,}/gi,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /([?&](?:access_token|token|key|sig|signature|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)[^&#\s"]+/gi,
];

export interface RedactOptions {
  /** Exact plaintext secrets known to the caller (e.g. the decrypted token in the Executor). */
  secrets?: readonly string[];
  maxDepth?: number;
}

function redactString(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const sec of secrets) if (sec.length >= 4) out = out.split(sec).join(REDACTED);
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, (m, p1: string | undefined) => (typeof p1 === "string" && p1.endsWith("=") ? `${p1}${REDACTED}` : REDACTED));
  }
  return out;
}

export function redact<T>(value: T, opts: RedactOptions = {}): T {
  const secrets = opts.secrets ?? [];
  const maxDepth = opts.maxDepth ?? 32;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > maxDepth) return REDACTED;
    if (typeof v === "string") return redactString(v, secrets);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) return REDACTED;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}
