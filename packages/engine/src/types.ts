import type { Diff, TargetRef } from "@relayon/connector-kit";

export interface SubmitRequest {
  tool: string;
  input: unknown;
  endUser?: string | null;
  runId?: string | null;
  agentName?: string | null;
  model?: string | null;
  idempotencyKey?: string | null;
  caller: "rest" | "mcp" | "sdk";
}

export interface ActionView {
  id: string;
  status: string;
  tool: string;
  kind: string;
  reversibility: string;
  run_id: string | null;
  parent_action_id: string | null;
  policy: { decision: string; rules: string[]; messages?: string[] };
  preview: Diff | null;
  result: unknown;
  error: { code: string; message: string; details?: unknown } | null;
  target: TargetRef | null;
  undo: { available: boolean; status: string; url: string | null };
  approval?: { id: string; status: string; expires_at: string } | null;
  hold?: { execute_at: string } | null;
  cost_usd: number;
  created_at: string;
  executed_at: string | null;
}

export interface UndoReport {
  undo_op_id: string;
  scope: "action" | "run";
  status: "succeeded" | "partial" | "failed" | "conflict";
  steps: Array<{
    action_id: string;
    tool: string;
    kind: "inverse" | "skipped";
    result: "undone" | "skipped" | "conflict" | "failed" | "not_run";
    reason?: string;
    undo_action_ids?: string[];
    changed_fields?: string[];
  }>;
}
