import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ExprError, evaluate, lazy, parse, truthy, type Node } from "./expr.js";

export const DECISIONS = ["allow", "hold", "require_approval", "block"] as const;
export type Decision = (typeof DECISIONS)[number];
const RANK: Record<Decision, number> = { allow: 0, hold: 1, require_approval: 2, block: 3 };

const strOrList = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(50)]);
const duration = z.string().regex(/^\d+(s|m|h|d)$/);

const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    match: z
      .object({
        tool: strOrList.optional(),
        app: strOrList.optional(),
        kind: strOrList.optional(),
        reversibility: strOrList.optional(),
        source: strOrList.optional(),
        environment: strOrList.optional(),
        agent: strOrList.optional(),
      })
      .strict()
      .default({}),
    when: z.string().max(2000).optional(),
    decision: z.enum(DECISIONS),
    message: z.string().max(500).optional(),
    hold_seconds: z.number().int().min(1).max(7 * 24 * 3600).optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
    approval: z
      .object({
        approvers: z.object({ roles: z.array(z.string()).min(1) }).strict().optional(),
        required: z.number().int().min(1).max(10).default(1),
        expires_in: duration.default("24h"),
        notify: z.array(z.enum(["dashboard", "webhook", "slack", "email"])).optional(),
        editable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(100),
    rules: z.array(RuleSchema).max(500),
  })
  .strict();

export type PolicyRule = z.infer<typeof RuleSchema>;
export type PolicyDoc = z.infer<typeof PolicySchema>;

export interface CompiledRule extends PolicyRule {
  whenAst?: Node;
}
export interface CompiledPolicy {
  name: string;
  rules: CompiledRule[];
}

export class PolicyValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid policy: ${issues.join("; ")}`);
    this.name = "PolicyValidationError";
  }
}

/** Parses YAML or JSON source, validates strictly, and compiles `when` clauses to ASTs. */
export function compilePolicy(source: string, format: "yaml" | "json"): CompiledPolicy {
  if (source.length > 256 * 1024) throw new PolicyValidationError(["policy too large"]);
  let raw: unknown;
  try {
    raw = format === "json" ? JSON.parse(source) : parseYaml(source, { maxAliasCount: 0 });
  } catch (e) {
    throw new PolicyValidationError([`could not parse ${format}: ${(e as Error).message}`]);
  }
  const res = PolicySchema.safeParse(raw);
  if (!res.success) throw new PolicyValidationError(res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const ids = new Set<string>();
  const issues: string[] = [];
  const rules = res.data.rules.map((r) => {
    if (ids.has(r.id)) issues.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (r.decision === "hold" && r.hold_seconds === undefined) {
      /* falls back to the project default */
    }
    let whenAst: Node | undefined;
    if (r.when) {
      try {
        whenAst = parse(r.when);
      } catch (e) {
        issues.push(`${r.id}.when: ${(e as Error).message}`);
      }
    }
    return { ...r, whenAst };
  });
  if (issues.length) throw new PolicyValidationError(issues);
  return { name: res.data.name, rules };
}

export interface DiffField {
  path: string;
  before: unknown;
  after: unknown;
}

export interface EvalContext {
  project: { id: string; environment: string; defaultHoldSeconds: number };
  agentName: string | null;
  endUser: string | null;
  tool: { id: string; app: string; kind: string; reversibility: string; source: string };
  input: unknown;
  diff: { fields: DiffField[] } | null;
  /** Kinds of the earlier actions in this run (for bulk guards). */
  run: { kinds: string[] };
  now: Date;
}

export interface PolicyResult {
  decision: Decision;
  ruleIds: string[];
  holdSeconds: number;
  messages: string[];
  approval: { roles: string[]; required: number; expiresInSeconds: number; editable: boolean } | null;
  /** true when no rule matched and the default applied. */
  defaulted: boolean;
}

function globMatch(pattern: string, value: string): boolean {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`).test(value);
}

function matchField(spec: string | string[] | undefined, value: string | null): boolean {
  if (spec === undefined) return true;
  if (value === null) return false;
  const list = Array.isArray(spec) ? spec : [spec];
  return list.some((p) => globMatch(p, value));
}

export function durationSeconds(d: string): number {
  const n = Number(d.slice(0, -1));
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[d.slice(-1) as "s" | "m" | "h" | "d"];
}

/** Defaults when no rule matches (§7.1). */
export function defaultDecision(reversibility: string, kind: string): { decision: Decision; holdSeconds?: number } {
  if (kind === "read" || reversibility === "read_only") return { decision: "allow" };
  if (reversibility === "reversible") return { decision: "allow" };
  if (reversibility === "compensatable") return { decision: "hold", holdSeconds: 30 };
  return { decision: "require_approval" };
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function scopeFor(ctx: EvalContext) {
  return {
    input: ctx.input,
    tool: ctx.tool,
    kind: ctx.tool.kind,
    agent: ctx.agentName,
    end_user: ctx.endUser,
    environment: ctx.project.environment,
    diff: {
      fields: ctx.diff?.fields ?? [],
      changed: (path: unknown) =>
        typeof path === "string" && (ctx.diff?.fields ?? []).some((f) => (f.path === path || f.path.startsWith(`${path}.`)) && JSON.stringify(f.before) !== JSON.stringify(f.after)),
      before: (path: unknown) => (typeof path === "string" ? ctx.diff?.fields.find((f) => f.path === path)?.before : undefined),
      after: (path: unknown) => (typeof path === "string" ? ctx.diff?.fields.find((f) => f.path === path)?.after : undefined),
    },
    run: {
      size: ctx.run.kinds.length,
      // run.count(<predicate over `kind`>), counting earlier actions plus this one.
      count: lazy((pred: Node) => [...ctx.run.kinds, ctx.tool.kind].filter((k) => truthy(evaluate(pred, { kind: k }))).length),
    },
    number: (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN),
    string: (v: unknown) => (v === null || v === undefined ? "" : String(v)),
    len: (v: unknown) => (typeof v === "string" || Array.isArray(v) ? v.length : 0),
    get: (obj: unknown, path: unknown) => (typeof path === "string" ? getPath(obj, path) : undefined),
    hour_utc: ctx.now.getUTCHours(),
  };
}

/**
 * Pure evaluator (§7.1): every rule whose `match` and `when` pass contributes; the most restrictive
 * decision wins (block > require_approval > hold > allow) and all matched rule ids are returned.
 * A `when` clause that errors counts as matched with require_approval: fail closed, never open.
 */
export function evaluatePolicies(policies: readonly CompiledPolicy[], ctx: EvalContext): PolicyResult {
  const rules = policies.flatMap((p) => p.rules).sort((a, b) => a.priority - b.priority);
  const scope = scopeFor(ctx);
  let best: Decision | null = null;
  const ruleIds: string[] = [];
  const messages: string[] = [];
  let holdSeconds = 0;
  let approval: PolicyResult["approval"] = null;

  for (const r of rules) {
    const m = r.match;
    if (
      !matchField(m.tool, ctx.tool.id) || !matchField(m.app, ctx.tool.app) || !matchField(m.kind, ctx.tool.kind) ||
      !matchField(m.reversibility, ctx.tool.reversibility) || !matchField(m.source, ctx.tool.source) ||
      !matchField(m.environment, ctx.project.environment) || !matchField(m.agent, ctx.agentName)
    ) continue;
    let decision: Decision = r.decision;
    if (r.whenAst) {
      try {
        if (!truthy(evaluate(r.whenAst, scope))) continue;
      } catch (e) {
        if (!(e instanceof ExprError) && !(e instanceof TypeError)) throw e;
        decision = RANK[r.decision] > RANK.require_approval ? r.decision : "require_approval";
        messages.push(`${r.id}: condition error, failing closed`);
      }
    }
    ruleIds.push(r.id);
    if (r.message) messages.push(r.message);
    if (decision === "hold") holdSeconds = Math.max(holdSeconds, r.hold_seconds ?? ctx.project.defaultHoldSeconds ?? 30);
    if (decision === "require_approval") {
      const a = r.approval;
      const next = {
        roles: a?.approvers?.roles ?? ["approver", "admin", "owner"],
        required: a?.required ?? 1,
        expiresInSeconds: durationSeconds(a?.expires_in ?? "24h"),
        editable: a?.editable ?? false,
      };
      // Combine conservatively: more approvers, shorter expiry, editable only if all allow it.
      approval = approval
        ? { roles: next.roles, required: Math.max(approval.required, next.required), expiresInSeconds: Math.min(approval.expiresInSeconds, next.expiresInSeconds), editable: approval.editable && next.editable }
        : next;
    }
    if (best === null || RANK[decision] > RANK[best]) best = decision;
  }

  if (best === null) {
    const d = defaultDecision(ctx.tool.reversibility, ctx.tool.kind);
    return {
      decision: d.decision,
      ruleIds: [],
      holdSeconds: d.decision === "hold" ? d.holdSeconds ?? 30 : 0,
      messages: [],
      approval: d.decision === "require_approval" ? { roles: ["approver", "admin", "owner"], required: 1, expiresInSeconds: 86400, editable: false } : null,
      defaulted: true,
    };
  }
  if (best === "hold" && holdSeconds === 0) holdSeconds = ctx.project.defaultHoldSeconds || 30;
  return {
    decision: best,
    ruleIds,
    holdSeconds: best === "hold" ? holdSeconds : 0,
    messages,
    approval: best === "require_approval" ? approval ?? { roles: ["approver", "admin", "owner"], required: 1, expiresInSeconds: 86400, editable: false } : null,
    defaulted: false,
  };
}
