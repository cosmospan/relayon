import { assertScope, assertToolAllowed, type TenantContext } from "@relayon/authz";
import type { ConnectorRegistry, Diff, Snapshot, TargetRef, ToolDef } from "@relayon/connector-kit";
import { RelayonError } from "@relayon/core";
import { newId, withTenant } from "@relayon/db";
import { appendAction, canonicalJson, getAction, listActions, patchAction, sha256, transition, type ActionFilter, type ActionRow } from "@relayon/ledger";
import { compilePolicy, evaluatePolicies, type CompiledPolicy, type PolicyResult } from "@relayon/policy";
import { planRunUndo } from "@relayon/undo";
import type pg from "pg";
import type { ExecutorClient } from "./executor-client.js";
import type { SnapshotSealer } from "./snapshots.js";
import type { ActionView, SubmitRequest, UndoReport } from "./types.js";

/** Schedules the hold job (BullMQ in production). The DB row is the source of truth; a sweeper backs it up. */
export interface HoldScheduler {
  schedule(job: { orgId: string; projectId: string; actionId: string; executeAt: Date }): Promise<void>;
}

export interface RelayDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  executor: ExecutorClient;
  sealer: SnapshotSealer;
  holds: HoldScheduler;
  now?: () => Date;
}

type Scope = { orgId: string; projectId: string };
interface ProjectRow { id: string; environment: string; default_hold_seconds: number; fail_mode: string; ledger_retention_days: number }

const WRITE_KINDS = new Set(["create", "update", "delete", "send", "pay", "other"]);

function errBody(e: unknown): { code: string; message: string; details?: unknown } {
  if (e instanceof RelayonError) return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  return { code: "RELAYON_INTERNAL", message: "Internal error" };
}

/**
 * The relay engine (§2.1). Every path goes through the tenant context derived from the credential;
 * all provider calls go to the Executor through signed single-use requests; every state change is a
 * guarded transition, so holds/approvals execute exactly once.
 */
export class Relay {
  readonly #d: RelayDeps;
  readonly #policyCache = new Map<string, CompiledPolicy>();

  constructor(deps: RelayDeps) {
    this.#d = deps;
  }

  get registry() {
    return this.#d.registry;
  }

  #now() {
    return this.#d.now?.() ?? new Date();
  }

  #scope(ctx: TenantContext): Scope {
    return { orgId: ctx.orgId, projectId: ctx.projectId };
  }

  // ---------------------------------------------------------------- submit

  async submit(ctx: TenantContext, req: SubmitRequest, opts: { previewOnly?: boolean } = {}): Promise<{ httpStatus: number; view: ActionView }> {
    const tool = this.#d.registry.tool(req.tool);
    assertToolAllowed(ctx.principal, tool, req.endUser ?? undefined);
    const input = this.#d.registry.parseInput(tool.id, req.input);
    const inputHash = sha256(canonicalJson({ tool: tool.id, input }));
    const scope = this.#scope(ctx);
    const idem = req.idempotencyKey ? String(req.idempotencyKey).slice(0, 200) : null;
    if (opts.previewOnly && idem) throw new RelayonError("RELAYON_INVALID_INPUT", "Previews do not take an idempotency key");

    // Step 1: resolve everything and append the ledger entry in one tenant transaction.
    const prep = await withTenant(this.#d.pool, scope, async (db) => {
      const project = (await db.query<ProjectRow>("select * from projects where id = $1", [scope.projectId])).rows[0];
      if (!project) throw new RelayonError("RELAYON_FORBIDDEN", "Project not found for this key");
      if (idem) {
        const prior = (await db.query<ActionRow>("select * from actions where project_id = $1 and idempotency_key = $2", [scope.projectId, idem])).rows[0];
        if (prior) {
          if (!prior.input_hash.equals(inputHash)) throw new RelayonError("RELAYON_IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different request", { actionId: prior.id });
          return { replay: prior } as const;
        }
      }
      const endUserId = req.endUser ? await this.#upsertEndUser(db, scope, req.endUser) : null;
      const connection = (await db.query<{ id: string }>(
        `select id from connections where app = $1 and status = 'active' and purpose = 'agent'
           and end_user_id is not distinct from $2 order by created_at desc limit 1`,
        [tool.app, endUserId],
      )).rows[0];
      if (!connection) throw new RelayonError("RELAYON_CONNECTION_MISSING", `No active ${tool.app} connection${req.endUser ? ` for end user ${req.endUser}` : ""}`);
      const runId = await this.#resolveRun(db, scope, req, endUserId);
      const runKinds = (await db.query<{ kind: string }>("select kind from actions where run_id = $1 and parent_action_id is null and status not in ('blocked','rejected','expired','cancelled')", [runId])).rows.map((r) => r.kind);
      const policies = await this.#loadPolicies(db);
      const row = await appendAction(db, {
        id: newId("action"), orgId: scope.orgId, projectId: scope.projectId, runId, parentActionId: null, endUserId,
        connectionId: connection.id, toolId: tool.id, source: "native", caller: opts.previewOnly ? "preview" : req.caller,
        principal: ctx.principal.keyId, agentName: req.agentName ?? ctx.principal.agentName, model: req.model ?? null,
        input, inputHash, idempotencyKey: idem, kind: tool.kind, reversibility: tool.reversibility,
        policyDecision: "allow", policyRuleIds: [], status: "received", createdAt: this.#now(),
      });
      if (WRITE_KINDS.has(tool.kind) && !opts.previewOnly) await this.#usage(db, scope, row.id, "protected_action", 1);
      return { row, project, runKinds, policies, endUserExternal: req.endUser ?? null } as const;
    });
    if ("replay" in prep && prep.replay) return { httpStatus: this.#statusFor(prep.replay.status), view: await this.view(ctx, prep.replay.id) };
    const { project } = prep;
    let row = prep.row;

    // Step 2: preview (diff) through the Executor. Reads skip it.
    let diff: Diff | null = null;
    if (tool.kind !== "read") {
      try {
        const pv = await this.#d.executor.run<{ diff: Diff }>("preview", this.#target(row), null);
        diff = pv.diff;
      } catch (e) {
        await withTenant(this.#d.pool, scope, (db) => transition(db, row.id, ["received"], "failed", { error: errBody(e) }));
        throw this.#withAction(e, row.id);
      }
    }

    // Step 3: policy (pure function) on the structured diff.
    const decision = evaluatePolicies(prep.policies, {
      project: { id: project.id, environment: project.environment, defaultHoldSeconds: project.default_hold_seconds },
      agentName: row.agent_name, endUser: prep.endUserExternal,
      tool: { id: tool.id, app: tool.app, kind: tool.kind, reversibility: tool.reversibility, source: "native" },
      input, diff: diff ? { fields: diff.fields } : null, run: { kinds: prep.runKinds }, now: this.#now(),
    });
    row = (await withTenant(this.#d.pool, scope, (db) =>
      transition(db, row.id, ["received"], "previewed", { preview: diff, policy_decision: decision.decision, policy_rule_ids: decision.ruleIds, target_ref: diff?.target ?? null }),
    ))!;

    if (opts.previewOnly) return { httpStatus: 200, view: { ...(await this.view(ctx, row.id)), policy: { decision: decision.decision, rules: decision.ruleIds, messages: decision.messages } } };

    return this.#route(ctx, row, tool, project, decision);
  }

  async #route(ctx: TenantContext, row: ActionRow, tool: ToolDef, project: ProjectRow, decision: PolicyResult): Promise<{ httpStatus: number; view: ActionView }> {
    const scope = this.#scope(ctx);
    switch (decision.decision) {
      case "block": {
        await withTenant(this.#d.pool, scope, (db) => transition(db, row.id, ["previewed"], "blocked", { error: { code: "RELAYON_POLICY_BLOCKED", message: decision.messages[0] ?? "Blocked by policy" } }));
        throw new RelayonError("RELAYON_POLICY_BLOCKED", decision.messages[0] ?? "Blocked by policy", { actionId: row.id, details: { rules: decision.ruleIds } });
      }
      case "require_approval": {
        const a = decision.approval!;
        await withTenant(this.#d.pool, scope, async (db) => {
          await transition(db, row.id, ["previewed"], "pending_approval");
          await db.query(
            `insert into approvals(id, org_id, project_id, action_id, status, required_approvers, approver_roles, expires_at)
             values ($1,$2,$3,$4,'pending',$5,$6,$7)`,
            [newId("approval"), scope.orgId, scope.projectId, row.id, a.required, a.roles, new Date(this.#now().getTime() + a.expiresInSeconds * 1000)],
          );
        });
        return { httpStatus: 202, view: await this.view(ctx, row.id) };
      }
      case "hold": {
        const executeAt = new Date(this.#now().getTime() + decision.holdSeconds * 1000);
        await withTenant(this.#d.pool, scope, async (db) => {
          await transition(db, row.id, ["previewed"], "held");
          await db.query("insert into held_actions(action_id, org_id, project_id, execute_at, status) values ($1,$2,$3,$4,'waiting')", [row.id, scope.orgId, scope.projectId, executeAt]);
        });
        await this.#d.holds.schedule({ ...scope, actionId: row.id, executeAt }).catch(() => undefined); // sweeper covers a lost job
        return { httpStatus: 202, view: await this.view(ctx, row.id) };
      }
      case "allow": {
        const exec = await withTenant(this.#d.pool, scope, (db) => transition(db, row.id, ["previewed"], "executing"));
        if (!exec) throw new RelayonError("RELAYON_INTERNAL", "Action moved concurrently", { actionId: row.id });
        const done = await this.#execute(scope, exec, tool, project, { isUndoStep: false });
        return { httpStatus: done.status === "succeeded" ? 200 : this.#statusFor(done.status, done.error), view: await this.view(ctx, row.id) };
      }
    }
  }

  /** Snapshot → execute → ledger. The action must already be `executing`. Never throws for upstream errors. */
  async #execute(scope: Scope, row: ActionRow, tool: ToolDef, project: ProjectRow, o: { isUndoStep: boolean }): Promise<ActionRow> {
    const started = Date.now();
    const write = WRITE_KINDS.has(tool.kind);
    let snapshotId: string | null = null;

    if (write && tool.snapshot && !o.isUndoStep) {
      try {
        const snap = await this.#d.executor.run<Snapshot>("snapshot", this.#target(row), null);
        snapshotId = newId("snapshot");
        const expires = new Date(this.#now().getTime() + project.ledger_retention_days * 86400_000);
        await withTenant(this.#d.pool, scope, (db) =>
          db.query(
            `insert into snapshots(id, action_id, org_id, target_ref, before_enc, before_etag, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
            [snapshotId, row.id, scope.orgId, JSON.stringify(snap.target), this.#d.sealer.seal(scope.orgId, row.id, "before", snap.before), snap.version ?? null, expires],
          ),
        );
      } catch (e) {
        if (project.fail_mode === "closed") {
          const err = e instanceof RelayonError && e.code !== "RELAYON_INTERNAL" ? { code: "RELAYON_SNAPSHOT_FAILED", message: "Could not capture the before-state; not executed (fail closed)", details: { cause: errBody(e) } } : { code: "RELAYON_SNAPSHOT_FAILED", message: "Could not capture the before-state; not executed (fail closed)" };
          return (await withTenant(this.#d.pool, scope, (db) => transition(db, row.id, ["executing"], "failed", { error: err, latency_ms: Date.now() - started })))!;
        }
        snapshotId = null;
      }
    }

    let res: { output: unknown; target: TargetRef; after?: unknown; version?: string };
    const upstreamStart = Date.now();
    try {
      res = await this.#d.executor.run("execute", this.#target(row), null);
    } catch (e) {
      return (await withTenant(this.#d.pool, scope, (db) =>
        transition(db, row.id, ["executing"], "failed", { error: errBody(e), latency_ms: Date.now() - started, upstream_latency_ms: Date.now() - upstreamStart }),
      ))!;
    }
    const upstreamMs = Date.now() - upstreamStart;
    const undoable = !o.isUndoStep && snapshotId !== null && typeof tool.planUndo === "function" && (tool.reversibility === "reversible" || tool.reversibility === "compensatable");
    const undoStatus = undoable ? "available" : o.isUndoStep || tool.reversibility === "read_only" ? "none" : "not_possible";

    return (await withTenant(this.#d.pool, scope, async (db) => {
      if (snapshotId) {
        await db.query("update snapshots set after_enc = $2, after_etag = $3 where id = $1", [snapshotId, this.#d.sealer.seal(scope.orgId, row.id, "after", res.after ?? null), res.version ?? null]);
      }
      await this.#usage(db, scope, row.id, "execution", 1);
      return transition(db, row.id, ["executing"], "succeeded", {
        result: { output: res.output }, target_ref: res.target, snapshot_id: snapshotId, undo_status: undoStatus,
        executed_at: this.#now(), latency_ms: Date.now() - started, upstream_latency_ms: upstreamMs,
      });
    }))!;
  }

  // ---------------------------------------------------------------- approvals

  async listApprovals(ctx: TenantContext, status = "pending") {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) =>
      (await db.query(
        `select a.id, a.action_id, a.status, a.expires_at, a.created_at, x.tool_id as tool, x.preview, x.principal as requested_by
         from approvals a join actions x on x.id = a.action_id where a.project_id = $1 and a.status = $2 order by a.created_at desc limit 100`,
        [ctx.projectId, status],
      )).rows,
    );
  }

  async decide(ctx: TenantContext, approvalId: string, decision: "approve" | "reject", reason?: string): Promise<{ httpStatus: number; view: ActionView }> {
    assertScope(ctx.principal, "approvals:decide");
    const scope = this.#scope(ctx);
    const out = await withTenant(this.#d.pool, scope, async (db) => {
      const ap = (await db.query<{ id: string; action_id: string; status: string; expires_at: Date }>("select * from approvals where id = $1 and project_id = $2 for update", [approvalId, scope.projectId])).rows[0];
      if (!ap) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Approval not found");
      const action = (await getAction(db, ap.action_id))!;
      if (action.principal === ctx.principal.keyId) throw new RelayonError("RELAYON_FORBIDDEN", "The key that requested an action cannot approve it (§7.4)");
      if (ap.status !== "pending") throw new RelayonError(ap.status === "expired" ? "RELAYON_APPROVAL_EXPIRED" : "RELAYON_APPROVAL_REJECTED", `Approval is ${ap.status}`, { actionId: action.id });
      if (ap.expires_at.getTime() <= this.#now().getTime()) {
        await db.query("update approvals set status = 'expired' where id = $1", [ap.id]);
        await transition(db, action.id, ["pending_approval"], "expired", { error: { code: "RELAYON_APPROVAL_EXPIRED", message: "Approval expired" } });
        return { expired: action.id } as const;
      }
      const status = decision === "approve" ? "approved" : "rejected";
      await db.query("update approvals set status = $2, decided_by = array_append(coalesce(decided_by, '{}'), $3), decided_at = now(), reason = $4 where id = $1", [ap.id, status, ctx.principal.keyId, reason ?? null]);
      await db.query("insert into audit_events(org_id, project_id, actor, event, target, data) values ($1,$2,$3,'approval.decided',$4,$5)", [scope.orgId, scope.projectId, ctx.principal.keyId, ap.id, JSON.stringify({ decision: status })]);
      if (decision === "reject") {
        await transition(db, action.id, ["pending_approval"], "rejected", { error: { code: "RELAYON_APPROVAL_REJECTED", message: reason ?? "Rejected by approver" } });
        return { rejected: action.id } as const;
      }
      await this.#usage(db, scope, action.id, "approval", 1);
      return { approved: await transition(db, action.id, ["pending_approval"], "approved") } as const;
    });
    if ("expired" in out && out.expired) throw new RelayonError("RELAYON_APPROVAL_EXPIRED", "Approval expired", { actionId: out.expired });
    if ("rejected" in out && out.rejected) return { httpStatus: 200, view: await this.view(ctx, out.rejected) };
    const approved = "approved" in out ? out.approved : null;
    if (!approved) throw new RelayonError("RELAYON_INTERNAL", "Action moved concurrently");
    // Snapshot is taken now, at approval time (§7.4 step 5).
    const exec = await withTenant(this.#d.pool, scope, (db) => transition(db, approved.id, ["approved"], "executing"));
    if (exec) await this.#execute(scope, exec, this.#d.registry.tool(exec.tool_id), await this.#project(scope), { isUndoStep: false });
    return { httpStatus: 200, view: await this.view(ctx, approved.id) };
  }

  /** Sweeper: expire overdue approvals across tenants (ids come from a narrow definer function). */
  async expireApprovals(limit = 100): Promise<number> {
    const due = (await this.#d.pool.query<{ approval_id: string; org_id: string; project_id: string }>("select * from relayon_due_approval_expiries($1)", [limit])).rows;
    for (const d of due) {
      await withTenant(this.#d.pool, { orgId: d.org_id, projectId: d.project_id }, async (db) => {
        const r = await db.query<{ action_id: string }>("update approvals set status = 'expired' where id = $1 and status = 'pending' returning action_id", [d.approval_id]);
        if (r.rows[0]) await transition(db, r.rows[0].action_id, ["pending_approval"], "expired", { error: { code: "RELAYON_APPROVAL_EXPIRED", message: "Not decided in time" } });
      });
    }
    return due.length;
  }

  // ---------------------------------------------------------------- holds

  /** Worker entry point: guarded held → executing, then execute. Exactly once across job + sweeper. */
  async runHeld(scope: Scope, actionId: string): Promise<"executed" | "skipped"> {
    const exec = await withTenant(this.#d.pool, scope, async (db) => {
      const row = await transition(db, actionId, ["held"], "executing");
      if (row) await db.query("update held_actions set status = 'executing' where action_id = $1", [actionId]);
      return row;
    });
    if (!exec) return "skipped";
    const done = await this.#execute(scope, exec, this.#d.registry.tool(exec.tool_id), await this.#project(scope), { isUndoStep: false });
    await withTenant(this.#d.pool, scope, (db) => db.query("update held_actions set status = $2 where action_id = $1", [actionId, done.status === "succeeded" ? "done" : "failed"]));
    return "executed";
  }

  async sweepHolds(limit = 100): Promise<number> {
    const due = (await this.#d.pool.query<{ action_id: string; org_id: string; project_id: string }>("select * from relayon_due_holds($1)", [limit])).rows;
    let n = 0;
    for (const d of due) if ((await this.runHeld({ orgId: d.org_id, projectId: d.project_id }, d.action_id)) === "executed") n++;
    return n;
  }

  async cancel(ctx: TenantContext, actionId: string): Promise<ActionView> {
    assertScope(ctx.principal, "actions:write");
    const ok = await withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const row = await transition(db, actionId, ["held"], "cancelled");
      if (row) await db.query("update held_actions set status = 'cancelled', cancelled_by = $2 where action_id = $1", [actionId, ctx.principal.keyId]);
      return row;
    });
    if (!ok) {
      const v = await this.view(ctx, actionId);
      throw new RelayonError("RELAYON_INVALID_INPUT", `Only held actions can be cancelled (status: ${v.status})`, { actionId });
    }
    return this.view(ctx, actionId);
  }

  // ---------------------------------------------------------------- undo

  async undoAction(ctx: TenantContext, actionId: string, opts: { force?: boolean } = {}): Promise<UndoReport> {
    assertScope(ctx.principal, "actions:write");
    const scope = this.#scope(ctx);
    const step = await this.#undoOne(ctx, actionId, opts.force ?? false);
    const status = step.result === "undone" ? "succeeded" : step.result === "conflict" ? "conflict" : "failed";
    const report: UndoReport = { undo_op_id: newId("undo"), scope: "action", status, steps: [step] };
    await this.#recordUndoOp(scope, ctx, report, { actionId, force: opts.force ?? false });
    if (step.result !== "undone" && step.result !== "conflict") {
      throw new RelayonError("RELAYON_UNDO_NOT_POSSIBLE", step.reason ?? "Undo is not possible", { actionId, details: { report } });
    }
    if (step.result === "conflict") throw new RelayonError("RELAYON_UNDO_CONFLICT", "The resource changed after the agent's write; pass force to override", { actionId, details: { report } });
    return report;
  }

  async undoRun(ctx: TenantContext, runId: string, opts: { force?: boolean; includeCompensations?: boolean } = {}): Promise<UndoReport> {
    assertScope(ctx.principal, "actions:write");
    const scope = this.#scope(ctx);
    const actions = await withTenant(this.#d.pool, scope, async (db) => {
      const run = (await db.query<{ id: string }>("select id from runs where (id = $1 or external_id = $1) and project_id = $2", [runId, scope.projectId])).rows[0];
      if (!run) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Run not found");
      await db.query("update runs set status = 'undoing' where id = $1", [run.id]);
      return { runId: run.id, rows: (await db.query<ActionRow>("select * from actions where run_id = $1", [run.id])).rows };
    });
    const plan = planRunUndo(actions.rows.map((a) => ({ id: a.id, seq: Number(a.seq), toolId: a.tool_id, reversibility: a.reversibility, undoStatus: a.undo_status, status: a.status, parentActionId: a.parent_action_id })), opts);
    const steps: UndoReport["steps"] = [];
    let stopped = false;
    for (const p of plan) {
      if (p.kind === "skipped") { steps.push({ action_id: p.actionId, tool: p.toolId, kind: "skipped", result: "skipped", ...(p.reason ? { reason: p.reason } : {}) }); continue; }
      if (stopped) { steps.push({ action_id: p.actionId, tool: p.toolId, kind: "inverse", result: "not_run", reason: "stopped after an earlier step" }); continue; }
      const s = await this.#undoOne(ctx, p.actionId, opts.force ?? false);
      steps.push(s);
      if (s.result !== "undone") stopped = true; // newest-first order matters: don't undo older writes past a failure
    }
    const inverse = steps.filter((s) => s.kind === "inverse");
    const undone = inverse.filter((s) => s.result === "undone").length;
    const status: UndoReport["status"] = inverse.some((s) => s.result === "conflict") ? "conflict" : undone === inverse.length ? "succeeded" : undone > 0 ? "partial" : "failed";
    const report: UndoReport = { undo_op_id: newId("undo"), scope: "run", status, steps };
    await this.#recordUndoOp(scope, ctx, report, { runId: actions.runId, force: opts.force ?? false });
    await withTenant(this.#d.pool, scope, (db) => db.query("update runs set status = $2 where id = $1", [actions.runId, status === "succeeded" ? "undone" : "partially_undone"]));
    return report;
  }

  async #undoOne(ctx: TenantContext, actionId: string, force: boolean): Promise<UndoReport["steps"][number]> {
    const scope = this.#scope(ctx);
    const loaded = await withTenant(this.#d.pool, scope, async (db) => {
      const a = await getAction(db, actionId);
      if (!a || a.project_id !== scope.projectId) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Action not found");
      const snap = a.snapshot_id ? (await db.query<{ target_ref: TargetRef; before_enc: Buffer; after_enc: Buffer | null; before_etag: string | null; after_etag: string | null; expires_at: Date }>("select * from snapshots where id = $1", [a.snapshot_id])).rows[0] : undefined;
      return { a, snap };
    });
    const { a, snap } = loaded;
    const base = { action_id: a.id, tool: a.tool_id, kind: "inverse" as const };
    if (a.parent_action_id) return { ...base, result: "failed", reason: "undo steps cannot themselves be undone" };
    if (a.status !== "succeeded") return { ...base, result: "failed", reason: `action is ${a.status}` };
    if (a.undo_status === "undone") return { ...base, result: "failed", reason: "already undone" };
    const tool = this.#d.registry.tool(a.tool_id);
    if (!tool.planUndo || !snap || !["available", "conflict", "failed"].includes(a.undo_status)) return { ...base, result: "failed", reason: `undo ${a.undo_status === "none" ? "not available" : a.undo_status}` };
    if (snap.expires_at.getTime() <= this.#now().getTime()) return { ...base, result: "failed", reason: "snapshot expired" };

    // Claim the undo (guards against two concurrent undos).
    const claimed = await withTenant(this.#d.pool, scope, (db) => patchAction(db, a.id, { undo_status: "undoing" }, { undo_status: ["available", "conflict", "failed"] }));
    if (!claimed) return { ...base, result: "failed", reason: "undo already in progress" };

    const target = { orgId: scope.orgId, projectId: scope.projectId, connectionId: a.connection_id, actionId: a.id, toolId: a.tool_id, inputHash: a.input_hash };
    const after = snap.after_enc ? this.#d.sealer.open(scope.orgId, a.id, "after", snap.after_enc) : undefined;
    try {
      const check = await this.#d.executor.run<{ conflict: boolean; changedFields?: string[] }>("undo_check", target, { target: a.target_ref ?? snap.target_ref, after, version: snap.after_etag ?? undefined });
      if (check.conflict && !force) {
        await withTenant(this.#d.pool, scope, (db) => patchAction(db, a.id, { undo_status: "conflict" }));
        return { ...base, result: "conflict", reason: "resource changed since the agent's write", changed_fields: check.changedFields ?? [] };
      }
      if (check.conflict && force) assertScope(ctx.principal, "undo:force");
    } catch (e) {
      await withTenant(this.#d.pool, scope, (db) => patchAction(db, a.id, { undo_status: e instanceof RelayonError && e.code === "RELAYON_FORBIDDEN" ? "conflict" : "failed" }));
      if (e instanceof RelayonError && e.code === "RELAYON_FORBIDDEN") return { ...base, result: "conflict", reason: "force requires the undo:force scope" };
      return { ...base, result: "failed", reason: `conflict check failed: ${errBody(e).message}` };
    }

    const before: Snapshot = { target: snap.target_ref, before: this.#d.sealer.open(scope.orgId, a.id, "before", snap.before_enc), ...(snap.before_etag ? { version: snap.before_etag } : {}) };
    const plan = tool.planUndo({ input: a.input as never, before, output: (a.result as { output?: unknown } | null)?.output, target: (a.target_ref ?? snap.target_ref) as TargetRef });
    const project = await this.#project(scope);
    const childIds: string[] = [];
    for (const step of plan.steps) {
      const stepTool = this.#d.registry.tool(step.tool);
      if (stepTool.app !== tool.app) throw new RelayonError("RELAYON_INTERNAL", "Undo step crosses apps");
      const input = this.#d.registry.parseInput(stepTool.id, step.input);
      const child = await withTenant(this.#d.pool, scope, async (db) => {
        const row = await appendAction(db, {
          id: newId("action"), orgId: scope.orgId, projectId: scope.projectId, runId: a.run_id, parentActionId: a.id, endUserId: a.end_user_id,
          connectionId: a.connection_id, toolId: stepTool.id, source: "native", caller: "undo", principal: ctx.principal.keyId,
          agentName: a.agent_name, model: null, input, inputHash: sha256(canonicalJson({ tool: stepTool.id, input })), idempotencyKey: null,
          kind: stepTool.kind, reversibility: stepTool.reversibility, policyDecision: "allow", policyRuleIds: ["relayon:undo"], status: "received", createdAt: this.#now(),
        });
        await transition(db, row.id, ["received"], "previewed", { preview: { target: a.target_ref, op: "other", fields: [], summary: step.description } });
        await this.#usage(db, scope, row.id, "undo", 1);
        return transition(db, row.id, ["previewed"], "executing");
      });
      childIds.push(child!.id);
      const done = await this.#execute(scope, child!, stepTool, project, { isUndoStep: true });
      if (done.status !== "succeeded") {
        await withTenant(this.#d.pool, scope, (db) => patchAction(db, a.id, { undo_status: "failed" }));
        return { ...base, result: "failed", reason: `undo step ${stepTool.id} failed: ${(done.error as { message?: string } | null)?.message ?? "error"}`, undo_action_ids: childIds };
      }
    }
    await withTenant(this.#d.pool, scope, (db) => patchAction(db, a.id, { undo_status: "undone" }));
    return { ...base, result: "undone", undo_action_ids: childIds };
  }

  async #recordUndoOp(scope: Scope, ctx: TenantContext, r: UndoReport, t: { actionId?: string; runId?: string; force: boolean }) {
    await withTenant(this.#d.pool, scope, (db) =>
      db.query(
        `insert into undo_ops(id, org_id, project_id, scope, action_id, run_id, requested_by, force, status, plan, report, finished_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
        [r.undo_op_id, scope.orgId, scope.projectId, r.scope, t.actionId ?? null, t.runId ?? null, ctx.principal.keyId, t.force,
          r.status, JSON.stringify(r.steps.map((s) => ({ action_id: s.action_id, tool: s.tool, kind: s.kind }))), JSON.stringify(r)],
      ),
    );
  }

  async getUndoOp(ctx: TenantContext, id: string) {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const r = (await db.query<{ report: UndoReport }>("select report from undo_ops where id = $1 and project_id = $2", [id, ctx.projectId])).rows[0];
      if (!r) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Undo operation not found");
      return r.report;
    });
  }

  // ---------------------------------------------------------------- reads

  async view(ctx: TenantContext, actionId: string): Promise<ActionView> {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const a = await getAction(db, actionId);
      if (!a || a.project_id !== ctx.projectId) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Action not found");
      const ap = (await db.query<{ id: string; status: string; expires_at: Date }>("select id, status, expires_at from approvals where action_id = $1 order by created_at desc limit 1", [a.id])).rows[0];
      const hold = (await db.query<{ execute_at: Date }>("select execute_at from held_actions where action_id = $1", [a.id])).rows[0];
      return toView(a, ap, hold);
    });
  }

  async list(ctx: TenantContext, f: ActionFilter): Promise<ActionView[]> {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => (await listActions(db, ctx.projectId, f)).map((a) => toView(a)));
  }

  async openRun(ctx: TenantContext, body: { external_id?: string; agent_name?: string; metadata?: Record<string, unknown> }) {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const id = newId("run");
      await db.query("insert into runs(id, org_id, project_id, external_id, agent_name, metadata) values ($1,$2,$3,$4,$5,$6)", [id, ctx.orgId, ctx.projectId, body.external_id ?? null, body.agent_name ?? ctx.principal.agentName, JSON.stringify(body.metadata ?? {})]);
      return { id, status: "open" };
    });
  }

  async getRun(ctx: TenantContext, runId: string) {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const run = (await db.query("select id, external_id, status, agent_name, started_at, total_cost_usd_micros from runs where (id = $1 or external_id = $1) and project_id = $2", [runId, ctx.projectId])).rows[0];
      if (!run) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", "Run not found");
      const actions = (await db.query<ActionRow>("select * from actions where run_id = $1 order by seq asc", [run.id])).rows.map((a) => toView(a));
      return { ...run, actions };
    });
  }

  // ---------------------------------------------------------------- policies & connections

  async putPolicy(ctx: TenantContext, body: { name: string; source: string; format: "yaml" | "json"; priority?: number; enabled?: boolean }) {
    assertScope(ctx.principal, "policies:write");
    const compiled = compilePolicy(body.source, body.format);
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const existing = (await db.query<{ id: string; version: number }>("select id, version from policies where project_id = $1 and name = $2", [ctx.projectId, body.name])).rows[0];
      const serialisable = { name: compiled.name, rules: compiled.rules.map(({ whenAst: _w, ...r }) => r) };
      if (existing) {
        await db.query("update policies set source = $2, source_format = $3, compiled = $4, version = version + 1, priority = $5, enabled = $6 where id = $1", [existing.id, body.source, body.format, JSON.stringify(serialisable), body.priority ?? 100, body.enabled ?? true]);
      } else {
        await db.query("insert into policies(id, org_id, project_id, name, source_format, source, compiled, priority, enabled, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [newId("policy"), ctx.orgId, ctx.projectId, body.name, body.format, body.source, JSON.stringify(serialisable), body.priority ?? 100, body.enabled ?? true, ctx.principal.keyId]);
      }
      await db.query("insert into audit_events(org_id, project_id, actor, event, target) values ($1,$2,$3,'policy.updated',$4)", [ctx.orgId, ctx.projectId, ctx.principal.keyId, body.name]);
      return { name: body.name, rules: compiled.rules.length };
    });
  }

  async listPolicies(ctx: TenantContext) {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => (await db.query("select id, name, version, source_format, source, enabled, priority from policies where project_id = $1 order by priority, name", [ctx.projectId])).rows);
  }

  async createConnection(ctx: TenantContext, body: { app: string; end_user?: string; account_label?: string }): Promise<{ id: string; app: string; status: string; needs_secret: boolean }> {
    assertScope(ctx.principal, "connections:write");
    const c = this.#d.registry.connector(body.app);
    if (!c) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", `Unknown app ${body.app}`);
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) => {
      const endUserId = body.end_user ? await this.#upsertEndUser(db, this.#scope(ctx), body.end_user) : null;
      const id = newId("connection");
      const authType = c.auth.type === "none" ? "none" : c.auth.type;
      const status = authType === "none" ? "active" : "pending";
      await db.query("insert into connections(id, org_id, project_id, end_user_id, app, auth_type, status, account_label) values ($1,$2,$3,$4,$5,$6,$7,$8)", [id, ctx.orgId, ctx.projectId, endUserId, body.app, authType, status, body.account_label ?? null]);
      await db.query("insert into audit_events(org_id, project_id, actor, event, target) values ($1,$2,$3,'connection.created',$4)", [ctx.orgId, ctx.projectId, ctx.principal.keyId, id]);
      return { id, app: body.app, status, needs_secret: authType !== "none" };
    });
  }

  async activateConnection(ctx: TenantContext, id: string) {
    await withTenant(this.#d.pool, this.#scope(ctx), (db) => db.query("update connections set status = 'active', updated_at = now() where id = $1 and project_id = $2", [id, ctx.projectId]));
  }

  async listConnections(ctx: TenantContext) {
    return withTenant(this.#d.pool, this.#scope(ctx), async (db) =>
      (await db.query("select c.id, c.app, c.status, c.auth_type, c.account_label, c.created_at, e.external_id as end_user from connections c left join end_users e on e.id = c.end_user_id where c.project_id = $1 order by c.created_at desc", [ctx.projectId])).rows,
    );
  }

  // ---------------------------------------------------------------- helpers

  #target(row: ActionRow) {
    return { orgId: row.org_id, projectId: row.project_id, connectionId: row.connection_id, actionId: row.id, toolId: row.tool_id, inputHash: row.input_hash };
  }

  async #project(scope: Scope): Promise<ProjectRow> {
    return withTenant(this.#d.pool, scope, async (db) => (await db.query<ProjectRow>("select * from projects where id = $1", [scope.projectId])).rows[0]!);
  }

  async #upsertEndUser(db: pg.PoolClient, scope: Scope, externalId: string): Promise<string> {
    if (externalId.length > 200) throw new RelayonError("RELAYON_INVALID_INPUT", "end_user too long");
    const r = await db.query<{ id: string }>(
      `insert into end_users(id, org_id, project_id, external_id) values ($1,$2,$3,$4)
       on conflict (project_id, external_id) do update set external_id = excluded.external_id returning id`,
      [newId("endUser"), scope.orgId, scope.projectId, externalId],
    );
    return r.rows[0]!.id;
  }

  async #resolveRun(db: pg.PoolClient, scope: Scope, req: SubmitRequest, endUserId: string | null): Promise<string> {
    if (req.runId) {
      const r = (await db.query<{ id: string; status: string }>("select id, status from runs where (id = $1 or external_id = $1) and project_id = $2", [req.runId, scope.projectId])).rows[0];
      if (r) return r.id;
      if (req.runId.length > 200) throw new RelayonError("RELAYON_INVALID_INPUT", "run_id too long");
    }
    const id = newId("run");
    await db.query("insert into runs(id, org_id, project_id, external_id, agent_name, end_user_id) values ($1,$2,$3,$4,$5,$6)", [id, scope.orgId, scope.projectId, req.runId ?? null, req.agentName ?? null, endUserId]);
    return id;
  }

  async #loadPolicies(db: pg.PoolClient): Promise<CompiledPolicy[]> {
    const rows = (await db.query<{ id: string; version: number; source: string; source_format: "yaml" | "json" }>("select id, version, source, source_format from policies where enabled order by priority")).rows;
    return rows.map((r) => {
      const key = `${r.id}:${r.version}`;
      let c = this.#policyCache.get(key);
      if (!c) {
        c = compilePolicy(r.source, r.source_format);
        this.#policyCache.set(key, c);
      }
      return c;
    });
  }

  async #usage(db: pg.PoolClient, scope: Scope, actionId: string, meter: string, q: number) {
    await db.query("insert into usage_events(org_id, project_id, action_id, meter, quantity) values ($1,$2,$3,$4,$5)", [scope.orgId, scope.projectId, actionId, meter, q]);
  }

  #statusFor(status: string, error?: unknown): number {
    if (status === "pending_approval" || status === "held") return 202;
    if (status === "failed") {
      const code = (error as { code?: string } | null)?.code;
      return code === "RELAYON_SNAPSHOT_FAILED" ? 424 : code === "RELAYON_UPSTREAM_RATE_LIMITED" ? 429 : 502;
    }
    return 200;
  }

  #withAction(e: unknown, actionId: string): RelayonError {
    if (e instanceof RelayonError) return new RelayonError(e.code, e.message, { actionId, ...(e.details ? { details: e.details } : {}) });
    return new RelayonError("RELAYON_INTERNAL", "Internal error", { actionId });
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function toView(a: ActionRow, ap?: { id: string; status: string; expires_at: Date }, hold?: { execute_at: Date }): ActionView {
  const undoAvailable = a.undo_status === "available" || a.undo_status === "conflict";
  return {
    id: a.id,
    status: a.status,
    tool: a.tool_id,
    kind: a.kind,
    reversibility: a.reversibility,
    run_id: a.run_id,
    parent_action_id: a.parent_action_id,
    policy: { decision: a.policy_decision, rules: a.policy_rule_ids },
    preview: (a.preview as Diff | null) ?? null,
    result: (a.result as { output?: unknown } | null)?.output ?? null,
    error: (a.error as ActionView["error"]) ?? null,
    target: (a.target_ref as TargetRef | null) ?? null,
    undo: { available: undoAvailable, status: a.undo_status, url: undoAvailable ? `/v1/actions/${a.id}/undo` : null },
    ...(ap ? { approval: { id: ap.id, status: ap.status, expires_at: ap.expires_at.toISOString() } } : {}),
    ...(hold ? { hold: { execute_at: hold.execute_at.toISOString() } } : {}),
    cost_usd: Number(a.cost_usd_micros) / 1_000_000,
    created_at: a.created_at.toISOString(),
    executed_at: iso(a.executed_at),
  };
}
