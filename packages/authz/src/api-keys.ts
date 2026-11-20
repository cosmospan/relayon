import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * Relayon API keys (§11.10): rl_live_<8-char id>_<32 bytes base62 secret>_<crc32 checksum>.
 * The fixed prefix lets secret scanners detect leaks. Only HMAC-SHA256(pepper, key) is stored.
 */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_RE = /^rl_(live|test)_([0-9a-z]{8})_([0-9A-Za-z]{43})_([0-9a-z]{6,7})$/;

function base62(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(43, "0");
}

function checksum(body: string): string {
  return crc32(body).toString(36).padStart(7, "0");
}

export interface NewApiKey {
  /** Full key: show ONCE to the user, never store or log it. */
  key: string;
  /** Public lookup prefix stored in api_keys.prefix, e.g. rl_live_ab12cd34. */
  prefix: string;
  hash: Buffer;
}

export function generateApiKey(pepper: Buffer, env: "live" | "test" = "live"): NewApiKey {
  const id = randomBytes(5).readUIntBE(0, 5).toString(36).padStart(8, "0").slice(-8);
  const body = `rl_${env}_${id}_${base62(randomBytes(32))}`;
  const key = `${body}_${checksum(body)}`;
  return { key, prefix: `rl_${env}_${id}`, hash: hashApiKey(pepper, key) };
}

export interface ParsedApiKey {
  env: "live" | "test";
  prefix: string;
}

/** Validates shape and checksum (cheap rejection of typos and random strings before any DB call). */
export function parseApiKey(key: string): ParsedApiKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const body = key.slice(0, key.lastIndexOf("_"));
  if (checksum(body) !== m[4]!.padStart(7, "0")) return null;
  return { env: m[1] as "live" | "test", prefix: `rl_${m[1]}_${m[2]}` };
}

export function hashApiKey(pepper: Buffer, key: string): Buffer {
  if (pepper.length < 32) throw new Error("API key pepper must be at least 32 bytes");
  return createHmac("sha256", pepper).update(key).digest();
}

export function verifyApiKey(pepper: Buffer, key: string, storedHash: Buffer): boolean {
  const h = hashApiKey(pepper, key);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}
