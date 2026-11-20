import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConnectorRegistry, createHttpClient, defineTool, mcpName } from "./index.js";

const tool = defineTool({
  id: "x.do", app: "x", title: "Do", description: "Does a thing.", kind: "update", reversibility: "reversible",
  input: z.object({ a: z.string() }).strict(),
  async resolveTarget() { return { app: "x", type: "t" }; },
  async execute() { return { output: 1, target: { app: "x", type: "t" } }; },
});

describe("ConnectorRegistry", () => {
  it("registers tools, resolves MCP names, and validates input strictly", () => {
    const r = new ConnectorRegistry().register({ app: "x", displayName: "X", auth: { type: "none" }, allowHosts: [], tools: [tool as never] });
    expect(mcpName("x.do")).toBe("x_do");
    expect(r.tool("x_do").id).toBe("x.do");
    expect(r.parseInput("x.do", { a: "1" })).toEqual({ a: "1" });
    expect(() => r.parseInput("x.do", { a: "1", b: 2 })).toThrow(/schema/);
    expect(() => r.tool("nope")).toThrow(/Unknown tool/);
  });

  it("refuses tools from another app and duplicates", () => {
    expect(() => new ConnectorRegistry().register({ app: "y", displayName: "Y", auth: { type: "none" }, allowHosts: [], tools: [tool as never] })).toThrow();
  });
});

describe("createHttpClient", () => {
  const res = (status: number, body = "{}", headers: Record<string, string> = {}) => ({
    status, headers: new Headers(headers), url: "", body: Buffer.from(body), text: () => body, json: () => JSON.parse(body),
  });

  it("retries 429/5xx then succeeds, passing the allowlist and auth header", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(429, "{}", { "retry-after": "0" })).mockResolvedValueOnce(res(200, '{"ok":true}'));
    const http = createHttpClient({ baseUrl: "https://api.x.com/", allowHosts: ["api.x.com"], credential: { apiKey: "k" }, authHeader: (c) => ({ authorization: `Bearer ${c.apiKey}` }), fetchImpl: f as never });
    expect(await http.get("/v1/thing")).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls[0]![1]).toMatchObject({ allowHosts: ["api.x.com"], headers: { authorization: "Bearer k" } });
  });

  it("maps errors to spec codes and refuses absolute paths", async () => {
    const http = createHttpClient({ baseUrl: "https://api.x.com/", allowHosts: ["api.x.com"], credential: null, maxRetries: 0, fetchImpl: (async () => res(404)) as never });
    await expect(http.get("/x")).rejects.toMatchObject({ code: "RELAYON_UPSTREAM_ERROR" });
    await expect(http.get("https://evil.com/")).rejects.toMatchObject({ code: "RELAYON_INVALID_INPUT" });
  });
});
