import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { REDACTED, checkTarget, embeddedV4, isBlockedIp, redact, safeFetch } from "./index.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("isBlockedIp (§11.9 SSRF corpus)", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.1.2.3", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:10.0.0.1", "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it("decodes IPv4-mapped forms", () => {
    expect(embeddedV4("::ffff:7f00:1")).toBe("127.0.0.1");
  });
});

describe("checkTarget", () => {
  const reject = async (url: string, opts = {}) => expect(checkTarget(url, { resolve: publicDns, ...opts })).rejects.toThrow();

  it.each([
    "http://example.com/",
    "https://127.0.0.1/",
    "https://2130706433/",          // decimal 127.0.0.1
    "https://0x7f000001/",          // hex 127.0.0.1
    "https://0177.0.0.1/",          // octal
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/",
    "https://localhost/",
    "https://foo.localhost/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "file:///etc/passwd",
    "gopher://example.com/",
  ])("rejects %s", (url) => reject(url));

  it("rejects hosts whose DNS includes any private address (rebinding)", async () => {
    await expect(
      checkTarget("https://rebind.example/", { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] }),
    ).rejects.toThrow(/private/);
  });

  it("enforces the allowlist", async () => {
    await reject("https://evil.com/", { allowHosts: ["api.linear.app"] });
    await expect(checkTarget("https://api.linear.app/graphql", { allowHosts: ["api.linear.app"], resolve: publicDns })).resolves.toBeTruthy();
    await expect(checkTarget("https://x.notion.com/", { allowHosts: ["*.notion.com"], resolve: publicDns })).resolves.toBeTruthy();
    await reject("https://notion.com.evil.com/", { allowHosts: ["*.notion.com"] });
  });

  it("blocks configured internal domains", async () => {
    process.env.RELAYON_INTERNAL_DOMAINS = "relayon.internal-svc.net";
    await reject("https://vault.relayon.internal-svc.net/");
    delete process.env.RELAYON_INTERNAL_DOMAINS;
  });

  it("accepts a public https URL and pins the resolved address", async () => {
    const { pinned } = await checkTarget("https://example.com/", { resolve: publicDns });
    expect(pinned.address).toBe("93.184.216.34");
  });
});

describe("safeFetch", () => {
  it("refuses loopback targets even with http allowed", async () => {
    const server = createServer((_req, res) => res.end("hi")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { allowHttp: true, allowPorts: [port] })).rejects.toThrow(/private/);
    server.close();
  });
});

describe("redact", () => {
  it("removes sensitive keys and token-shaped values", () => {
    const out = redact({
      access_token: "abc",
      nested: { Authorization: "Bearer abcdefghijkl", note: "key is ghp_abcdefghijklmnopqrstuvwxyz0123" },
      url: "https://x.s3.amazonaws.com/f?X-Amz-Signature=deadbeef&x=1",
      list: ["rl_live_abcd1234_abcdefghijklmnopqrstuvwxyz"],
      ok: 42,
    });
    expect(out).toEqual({
      access_token: REDACTED,
      nested: { Authorization: REDACTED, note: `key is ${REDACTED}` },
      url: `https://x.s3.amazonaws.com/f?X-Amz-Signature=${REDACTED}&x=1`,
      list: [REDACTED],
      ok: 42,
    });
  });

  it("scrubs known plaintext secrets wherever they appear", () => {
    expect(redact({ echo: "your token was plainsecret123 ok" }, { secrets: ["plainsecret123"] })).toEqual({ echo: `your token was ${REDACTED} ok` });
  });
});
