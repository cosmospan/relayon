import { createHash } from "node:crypto";

/** Canonical JSON: object keys sorted recursively; used for hashing inputs and ledger entries. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Buffer.isBuffer(v)) return JSON.stringify(v.toString("hex"));
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}
