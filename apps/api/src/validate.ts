import { RelayonError } from "@relayon/core";
import type { z } from "zod";

const MAX_DEPTH = 32;

function depth(v: unknown, d = 0): number {
  if (d > MAX_DEPTH) return d;
  if (Array.isArray(v)) return Math.max(d, ...v.map((x) => depth(x, d + 1)));
  if (v && typeof v === "object") return Math.max(d, ...Object.values(v).map((x) => depth(x, d + 1)));
  return d;
}

/** Parses a JSON body with a size cap and a nesting cap, then validates it strictly (§11.10). */
export async function readJson<T extends z.ZodType>(req: { text(): Promise<string> }, schema: T, maxBytes = 1024 * 1024): Promise<z.infer<T>> {
  const raw = await req.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new RelayonError("RELAYON_INVALID_INPUT", "Body too large");
  let json: unknown = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new RelayonError("RELAYON_INVALID_INPUT", "Body is not valid JSON");
    }
  }
  if (depth(json) > MAX_DEPTH) throw new RelayonError("RELAYON_INVALID_INPUT", "JSON nested too deeply");
  const r = schema.safeParse(json);
  if (!r.success) throw new RelayonError("RELAYON_INVALID_INPUT", "Invalid request body", { details: { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  return r.data;
}
