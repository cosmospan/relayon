import type pg from "pg";
import { canonicalJson, sha256 } from "./canonical.js";

export interface NewAction {
  id: string;
  orgId: string;
  projectId: string;
  runId: string | null;
  parentActionId: string | null;
  endUserId: string | null;
  connectionId: string | null;
  toolId: string;
  source: string;
  caller: string;
  principal: string;
  agentName: string | null;
  model: string | null;
  input: unknown;
  inputHash: Buffer;
  idempotencyKey: string | null;
  kind: string;
  reversibility: string;
  policyDecision: string;
  policyRuleIds: string[];
  status: string;
  createdAt: Date;
}

export interface ActionRow {
  id: string; org_id: string; project_id: string; run_id: string | null; parent_action_id: string | null;
  end_user_id: string | null; connection_id: string | null; tool_id: string; source: string; caller: string;
  principal: string | null; agent_name: string | null; model: string | null; input: unknown; input_hash: Buffer;
  idempotency_key: string | null; kind: string; reversibility: string; policy_decision: string; policy_rule_ids: string[];
  status: string; preview: unknown; result: unknown; error: unknown; target_ref: unknown; snapshot_id: string | null;
  undo_status: string; cost_usd_micros: string; latency_ms: number | null; upstream_latency_ms: number | null;
  created_at: Date; executed_at: Date | null; seq: string; prev_hash: Buffer | null; entry_hash: Buffer | null;
}

/** The immutable fields covered by the hash chain (§11 tamper evidence). */
function entryBody(a: Pick<ActionRow, "id" | "org_id" | "project_id" | "run_id" | "parent_action_id" | "tool_id" | "input_hash" | "kind" | "caller" | "principal" | "created_at">): string {
  return canonicalJson({
    id: a.id, org_id: a.org_id, project_id: a.project_id, run_id: a.run_id, parent_action_id: a.parent_action_id,
    tool_id: a.tool_id, input_hash: a.input_hash.toString("hex"), kind: a.kind, caller: a.caller, principal: a.principal,
    created_at: a.created_at.toISOString(),
  });
}

export function entryHash(prev: Buffer | null, body: string): Buffer {
  return sha256(Buffer.concat([prev ?? Buffer.alloc(32), Buffer.from(body)]));
}

/**
 * Appends an action to the ledger inside the caller's tenant transaction. A per-project advisory
 * lock serialises chain appends so prev_hash is always the previous entry.
 */
export async function appendAction(db: pg.ClientBase, a: NewAction): Promise<ActionRow> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger:${a.projectId}`]);
  const prev = (await db.query<{ entry_hash: Buffer | null }>("select entry_hash from actions where project_id = $1 order by seq desc limit 1", [a.projectId])).rows[0]?.entry_hash ?? null;
  const createdAt = new Date(Math.floor(a.createdAt.getTime()));
  const hash = entryHash(prev, entryBody({
    id: a.id, org_id: a.orgId, project_id: a.projectId, run_id: a.runId, parent_action_id: a.parentActionId, tool_id: a.toolId,
    input_hash: a.inputHash, kind: a.kind, caller: a.caller, principal: a.principal, created_at: createdAt,
  }));
  const { rows } = await db.query<ActionRow>(
    `insert into actions(id, org_id, project_id, run_id, parent_action_id, end_user_id, connection_id, tool_id, source, caller, principal,
       agent_name, model, input, input_hash, idempotency_key, kind, reversibility, policy_decision, policy_rule_ids, status, created_at, prev_hash, entry_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning *`,
    [a.id, a.orgId, a.projectId, a.runId, a.parentActionId, a.endUserId, a.connectionId, a.toolId, a.source, a.caller, a.principal,
      a.agentName, a.model, JSON.stringify(a.input), a.inputHash, a.idempotencyKey, a.kind, a.reversibility, a.policyDecision, a.policyRuleIds,
      a.status, createdAt, prev, hash],
  );
  return rows[0]!;
}

/**
 * Guarded status transition (§4.1): `UPDATE … WHERE id = $1 AND status = ANY($expected)`.
 * Returns the updated row, or null if another worker already moved the action.
 */
export async function transition(db: pg.ClientBase, id: string, from: readonly string[], to: string, patch: Record<string, unknown> = {}): Promise<ActionRow | null> {
  const allowed = new Set(["preview", "result", "error", "target_ref", "snapshot_id", "undo_status", "policy_decision", "policy_rule_ids", "latency_ms", "upstream_latency_ms", "executed_at", "cost_usd_micros"]);
  const cols = Object.keys(patch).filter((k) => {
    if (!allowed.has(k)) throw new Error(`transition: column ${k} may not be patched`);
    return true;
  });
  const sets = ["status = $3", ...cols.map((c, i) => `${c} = $${i + 4}`)];
  const vals = cols.map((c) => {
    const v = patch[c];
    return ["preview", "result", "error", "target_ref"].includes(c) && v !== null && v !== undefined ? JSON.stringify(v) : v;
  });
  const { rows } = await db.query<ActionRow>(`update actions set ${sets.join(", ")} where id = $1 and status = any($2) returning *`, [id, from, to, ...vals]);
  return rows[0] ?? null;
}

/** Updates non-status fields (e.g. undo_status) with an optional guard on the current value. */
export async function patchAction(db: pg.ClientBase, id: string, patch: { undo_status?: string; result?: unknown }, guard?: { undo_status?: readonly string[] }): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (patch.undo_status !== undefined) { vals.push(patch.undo_status); sets.push(`undo_status = $${vals.length}`); }
  if (patch.result !== undefined) { vals.push(JSON.stringify(patch.result)); sets.push(`result = $${vals.length}`); }
  let where = "id = $1";
  if (guard?.undo_status) { vals.push(guard.undo_status); where += ` and undo_status = any($${vals.length})`; }
  const r = await db.query(`update actions set ${sets.join(", ")} where ${where}`, vals);
  return (r.rowCount ?? 0) > 0;
}

export async function getAction(db: pg.ClientBase, id: string): Promise<ActionRow | null> {
  return (await db.query<ActionRow>("select * from actions where id = $1", [id])).rows[0] ?? null;
}

export interface ActionFilter {
  runId?: string;
  toolId?: string;
  status?: string;
  since?: Date;
  limit?: number;
}

export async function listActions(db: pg.ClientBase, projectId: string, f: ActionFilter = {}): Promise<ActionRow[]> {
  const where = ["project_id = $1"];
  const vals: unknown[] = [projectId];
  if (f.runId) { vals.push(f.runId); where.push(`run_id = $${vals.length}`); }
  if (f.toolId) { vals.push(f.toolId); where.push(`tool_id = $${vals.length}`); }
  if (f.status) { vals.push(f.status); where.push(`status = $${vals.length}`); }
  if (f.since) { vals.push(f.since); where.push(`created_at >= $${vals.length}`); }
  vals.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
  return (await db.query<ActionRow>(`select * from actions where ${where.join(" and ")} order by seq desc limit $${vals.length}`, vals)).rows;
}

/** Re-computes the chain for a project. Returns the id of the first broken entry, or null. */
export async function verifyChain(db: pg.ClientBase, projectId: string): Promise<string | null> {
  const { rows } = await db.query<ActionRow>("select * from actions where project_id = $1 order by seq asc", [projectId]);
  let prev: Buffer | null = null;
  for (const r of rows) {
    const expect = entryHash(prev, entryBody(r));
    if (!r.entry_hash || !expect.equals(r.entry_hash) || !(prev === null ? r.prev_hash === null : r.prev_hash?.equals(prev))) return r.id;
    prev = r.entry_hash;
  }
  return null;
}
