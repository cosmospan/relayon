import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROLES, assertToolAllowed, generateApiKey, hashApiKey, parseApiKey, roleCan, verifyApiKey, type ApiKeyPrincipal } from "./index.js";

const pepper = randomBytes(32);

describe("API keys (§11.10)", () => {
  it("have the documented format and a valid checksum", () => {
    const k = generateApiKey(pepper);
    expect(k.key).toMatch(/^rl_live_[0-9a-z]{8}_[0-9A-Za-z]{43}_[0-9a-z]{7}$/);
    expect(parseApiKey(k.key)).toEqual({ env: "live", prefix: k.prefix });
    expect(k.key.startsWith(k.prefix)).toBe(true);
  });

  it("reject typos via the checksum", () => {
    const k = generateApiKey(pepper);
    const typo = k.key.slice(0, 20) + (k.key[20] === "a" ? "b" : "a") + k.key.slice(21);
    expect(parseApiKey(typo)).toBeNull();
    expect(parseApiKey("rl_live_nope")).toBeNull();
  });

  it("verify by HMAC with constant-time comparison; wrong pepper fails", () => {
    const k = generateApiKey(pepper);
    expect(verifyApiKey(pepper, k.key, k.hash)).toBe(true);
    expect(verifyApiKey(randomBytes(32), k.key, k.hash)).toBe(false);
    expect(k.hash.equals(hashApiKey(pepper, k.key))).toBe(true);
  });

  it("refuse a short pepper", () => {
    expect(() => hashApiKey(Buffer.alloc(8), "x")).toThrow();
  });
});

describe("RBAC (§11.10)", () => {
  it("denies by default and keeps sensitive permissions narrow", () => {
    expect(roleCan("viewer", "actions:write")).toBe(false);
    expect(roleCan("approver", "approvals:decide")).toBe(true);
    expect(roleCan("developer", "undo:force")).toBe(false);
    expect(roleCan("developer", "keys:manage")).toBe(false);
    expect(roleCan("admin", "undo:force")).toBe(true);
    expect(roleCan("nobody" as never, "actions:read")).toBe(false);
    for (const r of ROLES) expect(roleCan(r, "actions:read")).toBe(true);
  });
});

describe("agent key scoping (§11.7)", () => {
  const base: ApiKeyPrincipal = {
    type: "api_key", keyId: "key_1", scopes: ["actions:write", "actions:read"], agentName: "bot",
    allowedApps: null, allowedTools: null, maxKind: null, allowedEndUsers: null,
  };
  const tool = { id: "hubspot.update_deal", app: "hubspot", kind: "update" };

  it("allows by default", () => expect(() => assertToolAllowed(base, tool)).not.toThrow());
  it("enforces apps and tool globs", () => {
    expect(() => assertToolAllowed({ ...base, allowedApps: ["notion"] }, tool)).toThrow(/app/);
    expect(() => assertToolAllowed({ ...base, allowedTools: ["hubspot.get_*"] }, tool)).toThrow(/tool/);
    expect(() => assertToolAllowed({ ...base, allowedTools: ["hubspot.*"] }, tool)).not.toThrow();
  });
  it("enforces max_kind", () => {
    expect(() => assertToolAllowed({ ...base, maxKind: "create" }, tool)).toThrow(/max_kind/);
    expect(() => assertToolAllowed({ ...base, maxKind: "delete" }, tool)).not.toThrow();
    expect(() => assertToolAllowed({ ...base, maxKind: "pay" }, { ...tool, kind: "other" })).toThrow();
  });
  it("enforces end users", () => {
    expect(() => assertToolAllowed({ ...base, allowedEndUsers: ["u_1"] }, tool)).toThrow(/end user/);
    expect(() => assertToolAllowed({ ...base, allowedEndUsers: ["u_1"] }, tool, "u_1")).not.toThrow();
  });
  it("requires actions:write", () => {
    expect(() => assertToolAllowed({ ...base, scopes: ["actions:read"] }, tool)).toThrow(/actions:write/);
  });
});
