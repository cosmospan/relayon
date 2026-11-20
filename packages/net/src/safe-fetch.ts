import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { isBlockedIp } from "./ip.js";

export class SafeFetchError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Exact hosts or "*.example.com" wildcards. Native connectors MUST set this (§11.9). */
  allowHosts?: readonly string[];
  /** Plain http is refused unless explicitly allowed (local dev only). */
  allowHttp?: boolean;
  allowPorts?: readonly number[];
  maxRedirects?: number;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Injectable for tests. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  url: string;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /^metadata\.google\.internal$/i, /\.internal$/i, /\.local$/i, /^metadata$/i];

function extraBlockedSuffixes(): string[] {
  return (process.env.RELAYON_INTERNAL_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

async function defaultResolve(host: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Validates a URL and returns the single address to pin the connection to. */
export async function checkTarget(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{ url: URL; pinned: ResolvedAddress }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("invalid_url", "Invalid URL");
  }
  if (url.username || url.password) throw new SafeFetchError("credentials_in_url", "URLs with credentials are not allowed");
  const httpOk = opts.allowHttp === true && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpOk) throw new SafeFetchError("scheme", "Only https is allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const ports = opts.allowPorts ?? (httpOk ? [443, 80] : [443]);
  if (!ports.includes(port)) throw new SafeFetchError("port", `Port ${port} is not allowed`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.some((re) => re.test(host)) || extraBlockedSuffixes().some((s) => host.toLowerCase() === s || host.toLowerCase().endsWith(`.${s}`))) {
    throw new SafeFetchError("blocked_host", "Host is not allowed");
  }
  if (opts.allowHosts && !hostAllowed(host, opts.allowHosts)) throw new SafeFetchError("not_allowlisted", "Host is not on the allowlist");

  let addrs: ResolvedAddress[];
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else {
    try {
      addrs = await (opts.resolve ?? defaultResolve)(host);
    } catch {
      throw new SafeFetchError("dns", "DNS resolution failed");
    }
  }
  if (addrs.length === 0) throw new SafeFetchError("dns", "No addresses");
  // Every resolved address must be public, not just the first (§11.9).
  if (addrs.some((a) => isBlockedIp(a.address))) throw new SafeFetchError("blocked_ip", "Resolves to a private or reserved address");
  return { url, pinned: addrs[0]! };
}

/**
 * The only way Relayon code may make outbound HTTP requests (§11.9, CLAUDE.md). Resolves DNS,
 * checks every address, pins the socket to the checked IP (defeats DNS rebinding), disables
 * redirects by default (max 3, each re-checked), caps the body at 10 MB and enforces timeouts.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = Math.min(opts.maxRedirects ?? 0, 3);
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const deadline = AbortSignal.timeout(opts.totalTimeoutMs ?? 30_000);
  let current = rawUrl;
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; ; hop++) {
    const { url, pinned } = await checkTarget(current, opts);
    const agent = new Agent({
      connect: {
        timeout: opts.connectTimeoutMs ?? 5_000,
        lookup: ((_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (options?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as unknown as LookupFunction,
      },
    });
    try {
      const res = await undiciFetch(url, {
        method,
        headers: opts.headers,
        body: body as never,
        redirect: "manual",
        signal: deadline,
        dispatcher: agent,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new SafeFetchError("redirect", "Redirects are not allowed");
        current = new URL(res.headers.get("location")!, url).toString();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new SafeFetchError("too_large", "Response exceeds size limit");
          chunks.push(Buffer.from(chunk));
        }
      }
      const buf = Buffer.concat(chunks);
      return {
        status: res.status,
        headers: res.headers as unknown as Headers,
        url: url.toString(),
        body: buf,
        text: () => buf.toString("utf8"),
        json: <T>() => JSON.parse(buf.toString("utf8")) as T,
      };
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}
