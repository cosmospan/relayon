import { RelayonError } from "@relayon/core";
import { safeFetch, type SafeFetchOptions } from "@relayon/net";
import type { HttpClient, ToolCredential } from "./types.js";

export interface HttpClientOptions {
  baseUrl: string;
  allowHosts: readonly string[];
  credential: ToolCredential | null;
  authHeader?: (c: ToolCredential) => Record<string, string>;
  maxRetries?: number;
  fetchImpl?: typeof safeFetch;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP client for connectors: safeFetch only, auth injected, retries on 429/5xx with backoff. */
export function createHttpClient(o: HttpClientOptions): HttpClient {
  const f = o.fetchImpl ?? safeFetch;
  const maxRetries = o.maxRetries ?? 3;
  const auth = o.credential && o.authHeader ? o.authHeader(o.credential) : {};

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    if (!path.startsWith("/")) throw new RelayonError("RELAYON_INVALID_INPUT", "Connector paths must be relative");
    const url = new URL(path, o.baseUrl).toString();
    const opts: SafeFetchOptions = {
      method,
      allowHosts: o.allowHosts,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers, ...auth },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      const res = await f(url, opts);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 250 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) throw new RelayonError("RELAYON_UPSTREAM_RATE_LIMITED", "Upstream rate limited", { details: { retry_after: res.headers.get("retry-after") } });
      if (res.status >= 400) throw new RelayonError("RELAYON_UPSTREAM_ERROR", `Upstream returned ${res.status}`, { details: { upstream_status: res.status } });
      return (res.body.length ? res.json<T>() : (undefined as T));
    }
  }

  return {
    request,
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b ?? {}),
    patch: (p, b) => request("PATCH", p, b ?? {}),
    delete: (p) => request("DELETE", p),
  };
}
