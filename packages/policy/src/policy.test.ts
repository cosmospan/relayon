import { describe, expect, it } from "vitest";
import { ExprError, compilePolicy, evaluate, evaluatePolicies, parse, PolicyValidationError, type EvalContext } from "./index.js";

const SPEC_YAML = `
version: 1
name: production-safety
rules:
  - id: block-hubspot-merges
    match: { tool: "hubspot.merge_*" }
    decision: block
    message: "Merges are not allowed for agents."
  - id: approve-deletes-and-sends
    match: { kind: [delete, send, pay] }
    decision: require_approval
    approval:
      approvers: { roles: [approver, admin] }
      required: 1
      expires_in: 24h
      notify: [dashboard, webhook]
  - id: hold-external-github-comments
    match: { tool: "github.create_comment" }
    when: 'input.repo.startsWith("public-")'
    decision: hold
    hold_seconds: 60
  - id: big-deal-change
    match: { tool: "hubspot.update_deal" }
    when: 'diff.changed("amount") && number(input.properties.amount) > 50000'
    decision: require_approval
  - id: bulk-guard
    match: { kind: [update, delete] }
    when: 'run.count(kind in ["update","delete"]) > 25'
    decision: require_approval
    message: "More than 25 writes in one run."
  - id: unknown-proxy-tools
    match: { source: [upstream_mcp, composio, treg], reversibility: unknown }
    decision: hold
    hold_seconds: 30
  - id: staging-free
    match: { environment: development }
    decision: allow
    priority: 10
`;

const policy = compilePolicy(SPEC_YAML, "yaml");

function ctx(over: Omit<Partial<EvalContext>, "tool"> & { tool?: Partial<EvalContext["tool"]> } = {}): EvalContext {
  return {
    project: { id: "prj_1", environment: "production", defaultHoldSeconds: 0, ...(over.project ?? {}) },
    agentName: over.agentName ?? "bot",
    endUser: over.endUser ?? null,
    tool: { id: "demo.update_record", app: "demo", kind: "update", reversibility: "reversible", source: "native", ...(over.tool ?? {}) },
    input: over.input ?? {},
    diff: over.diff ?? null,
    run: over.run ?? { kinds: [] },
    now: over.now ?? new Date("2026-11-20T12:00:00Z"),
  };
}

describe("expression language (no eval)", () => {
  const scope = {
    input: { repo: "public-site", n: 5, tags: ["a", "b"], s: "hello" },
    number: (v: unknown) => Number(v),
  };
  it.each([
    ['input.repo.startsWith("public-")', true],
    ['input.repo.startsWith("private-")', false],
    ['input.repo.endsWith("site")', true],
    ['input.s.contains("ell")', true],
    ["input.n > 3", true],
    ["input.n >= 5", true],
    ["input.n < 5", false],
    ["input.n <= 4", false],
    ["input.n == 5", true],
    ['input.n == "5"', true],
    ["input.n != 5", false],
    ['"a" in input.tags', true],
    ['"z" in input.tags', false],
    ['input.tags.contains("b")', true],
    ["input.missing == null", false],
    ["!input.missing", true],
    ["input.n > 3 && input.n < 10", true],
    ["input.n > 30 || input.n < 10", true],
    ["(input.n > 30 || input.n < 10) && false", false],
    ['number("12000") > 50000', false],
    ["input.s.length == 5", true],
    ["-1 < 0", true],
    ["input.a.b.c.d", undefined],
  ])("%s → %s", (src, expected) => {
    expect(evaluate(parse(src), scope)).toBe(expected);
  });

  it.each([
    "input.__proto__",
    "input.constructor",
    "constructor.constructor('x')",
  ])("refuses prototype access: %s", (src) => {
    expect(() => evaluate(parse(src), scope)).toThrow(ExprError);
  });

  it.each(["input.", "1 +", '"unterminated', "a ; b", "x = 1", "`tpl`"])("rejects bad syntax: %s", (src) => {
    expect(() => parse(src)).toThrow(ExprError);
  });

  it("rejects absurdly long input", () => {
    expect(() => parse("a".repeat(3000))).toThrow(/too long/);
  });

  it("does not call arbitrary scope values", () => {
    expect(() => evaluate(parse("input.s()"), scope)).toThrow(ExprError);
  });
});

describe("policy compilation", () => {
  it("parses the spec's YAML example and the JSON form", () => {
    expect(policy.rules).toHaveLength(7);
    const json = compilePolicy(JSON.stringify({ version: 1, name: "p", rules: [{ id: "r", match: { kind: ["delete"] }, decision: "require_approval" }] }), "json");
    expect(json.rules[0]!.id).toBe("r");
  });

  it.each([
    ["unknown top-level key", `version: 1\nname: p\nrules: []\nextra: 1`],
    ["unknown match key", `version: 1\nname: p\nrules:\n  - id: r\n    match: { colour: red }\n    decision: allow`],
    ["bad decision", `version: 1\nname: p\nrules:\n  - id: r\n    decision: maybe`],
    ["bad version", `version: 2\nname: p\nrules: []`],
    ["duplicate ids", `version: 1\nname: p\nrules:\n  - id: r\n    decision: allow\n  - id: r\n    decision: block`],
    ["bad when", `version: 1\nname: p\nrules:\n  - id: r\n    when: "input.("\n    decision: allow`],
    ["bad id", `version: 1\nname: p\nrules:\n  - id: "Bad Id"\n    decision: allow`],
    ["yaml alias bomb", `version: 1\nname: &a p\nrules: []\nx: *a`],
  ])("rejects %s", (_n, src) => {
    expect(() => compilePolicy(src, "yaml")).toThrow(PolicyValidationError);
  });
});

describe("defaults when no rule matches (§7.1)", () => {
  it.each([
    ["read", "read_only", "allow"],
    ["update", "reversible", "allow"],
    ["create", "reversible", "allow"],
    ["create", "compensatable", "hold"],
    ["send", "irreversible", "require_approval"],
    ["other", "unknown", "require_approval"],
  ])("%s/%s → %s", (kind, reversibility, decision) => {
    const r = evaluatePolicies([], ctx({ tool: { kind, reversibility } }));
    expect(r.decision).toBe(decision);
    expect(r.defaulted).toBe(true);
    if (decision === "hold") expect(r.holdSeconds).toBe(30);
  });
});

describe("spec example policy", () => {
  it.each([
    ["merge blocked", { tool: { id: "hubspot.merge_contacts", app: "hubspot", kind: "update" } }, "block", ["block-hubspot-merges"]],
    ["delete needs approval", { tool: { id: "demo.delete_record", kind: "delete" } }, "require_approval", ["approve-deletes-and-sends"]],
    ["send needs approval", { tool: { id: "gmail.send", kind: "send", reversibility: "irreversible" } }, "require_approval", ["approve-deletes-and-sends"]],
    ["public github comment held", { tool: { id: "github.create_comment", kind: "create", reversibility: "compensatable" }, input: { repo: "public-docs" } }, "hold", ["hold-external-github-comments"]],
    ["private github comment defaults to hold (compensatable)", { tool: { id: "github.create_comment", kind: "create", reversibility: "compensatable" }, input: { repo: "internal" } }, "hold", []],
    ["plain update allowed (default)", {}, "allow", []],
    ["unknown proxied tool held", { tool: { id: "upstream:ups_1/foo", source: "upstream_mcp", reversibility: "unknown", kind: "other" } }, "hold", ["unknown-proxy-tools"]],
    ["development env allow rule matches but restrictive still wins", { project: { id: "p", environment: "development", defaultHoldSeconds: 0 }, tool: { id: "demo.delete_record", kind: "delete" } }, "require_approval", ["staging-free", "approve-deletes-and-sends"]],
  ] as const)("%s", (_n, over, decision, rules) => {
    const r = evaluatePolicies([policy], ctx(over as never));
    expect(r.decision).toBe(decision);
    expect(r.ruleIds).toEqual(rules);
  });

  it("big deal change needs approval only when amount changes above 50k", () => {
    const tool = { id: "hubspot.update_deal", app: "hubspot" };
    const big = ctx({ tool, input: { properties: { amount: "60000" } }, diff: { fields: [{ path: "amount", before: "100", after: "60000" }] } });
    expect(evaluatePolicies([policy], big).ruleIds).toEqual(["big-deal-change"]);
    const small = ctx({ tool, input: { properties: { amount: "600" } }, diff: { fields: [{ path: "amount", before: "100", after: "600" }] } });
    expect(evaluatePolicies([policy], small).decision).toBe("allow");
    const unchanged = ctx({ tool, input: { properties: { amount: "60000" } }, diff: { fields: [{ path: "amount", before: "60000", after: "60000" }] } });
    expect(evaluatePolicies([policy], unchanged).decision).toBe("allow");
  });

  it("bulk guard trips after 25 writes in a run", () => {
    expect(evaluatePolicies([policy], ctx({ run: { kinds: Array(24).fill("update") } })).decision).toBe("allow");
    const r = evaluatePolicies([policy], ctx({ run: { kinds: [...Array(25).fill("update"), "read", "read"] } }));
    expect(r.decision).toBe("require_approval");
    expect(r.messages).toContain("More than 25 writes in one run.");
  });

  it("uses the rule's hold seconds and the approval settings", () => {
    const h = evaluatePolicies([policy], ctx({ tool: { id: "github.create_comment", kind: "create", reversibility: "compensatable" }, input: { repo: "public-x" } }));
    expect(h.holdSeconds).toBe(60);
    const a = evaluatePolicies([policy], ctx({ tool: { kind: "delete" } }));
    expect(a.approval).toEqual({ roles: ["approver", "admin"], required: 1, expiresInSeconds: 86400, editable: false });
  });
});

describe("most-restrictive-wins and fail closed", () => {
  const p = compilePolicy(
    `version: 1
name: combo
rules:
  - id: allow-all
    decision: allow
  - id: hold-demo
    match: { app: demo }
    decision: hold
    hold_seconds: 5
  - id: hold-demo-long
    match: { app: demo }
    decision: hold
    hold_seconds: 50
  - id: block-agent-x
    match: { agent: "x-*" }
    decision: block
  - id: broken
    match: { tool: "demo.broken" }
    when: 'missingfn() == 1'
    decision: allow
  - id: approval-strict
    match: { tool: "demo.strict" }
    decision: require_approval
    approval: { required: 2, expires_in: 30m }
  - id: approval-loose
    match: { tool: "demo.strict" }
    decision: require_approval
    approval: { required: 1, expires_in: 2h, editable: true }
`,
    "yaml",
  );

  it("hold beats allow and uses the longest hold", () => {
    const r = evaluatePolicies([p], ctx());
    expect(r.decision).toBe("hold");
    expect(r.holdSeconds).toBe(50);
    expect(r.ruleIds).toEqual(["allow-all", "hold-demo", "hold-demo-long"]);
  });

  it("block beats everything", () => {
    expect(evaluatePolicies([p], ctx({ agentName: "x-123" })).decision).toBe("block");
  });

  it("allow rule alone overrides the default for irreversible tools", () => {
    expect(evaluatePolicies([p], ctx({ tool: { app: "other", kind: "send", reversibility: "irreversible" } })).decision).toBe("allow");
  });

  it("a condition that errors fails closed to require_approval", () => {
    const r = evaluatePolicies([p], ctx({ tool: { id: "demo.broken" }, input: { a: "x" } }));
    expect(r.decision).toBe("require_approval");
    expect(r.messages.some((m) => m.includes("failing closed"))).toBe(true);
  });

  it("combines approvals conservatively", () => {
    const r = evaluatePolicies([p], ctx({ tool: { id: "demo.strict" } }));
    expect(r.approval).toMatchObject({ required: 2, expiresInSeconds: 1800, editable: false });
  });

  it("multiple policies are merged", () => {
    const blockAll = compilePolicy(`version: 1\nname: b\nrules:\n  - id: nope\n    decision: block`, "yaml");
    expect(evaluatePolicies([p, blockAll], ctx()).decision).toBe("block");
  });

  it("is deterministic and pure", () => {
    const c = ctx();
    expect(evaluatePolicies([p], c)).toEqual(evaluatePolicies([p], c));
  });
});
