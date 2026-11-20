import { fetch as undiciFetch } from "undici";

/**
 * Calls Relayon's OWN internal services (Executor, Connect) at a base URL fixed by deployment
 * config, never a user-supplied URL. Provider/upstream/webhook traffic must use safeFetch.
 * Production adds mTLS (§11.2) via the dispatcher.
 */
export function createInternalClient(baseUrl: string, opts: { timeoutMs?: number } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("internal client needs http(s)");
  return async function post(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
    if (!path.startsWith("/internal/")) throw new Error("internal client only calls /internal/ paths");
    const res = await undiciFetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 35_000),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}
