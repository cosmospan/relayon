/**
 * Undo planning (§5.1 rules 4–5, US-4/US-5). Pure functions: which actions to undo, in which order,
 * and why others are skipped. Execution lives in the relay engine so undo steps are themselves
 * ordinary, logged actions with parent_action_id.
 */
export interface UndoCandidate {
  id: string;
  seq: number;
  toolId: string;
  reversibility: string;
  undoStatus: string;
  status: string;
  parentActionId: string | null;
}

export interface RunUndoStep {
  actionId: string;
  toolId: string;
  kind: "inverse" | "skipped";
  reason?: string;
}

export function planRunUndo(actions: readonly UndoCandidate[], opts: { includeCompensations?: boolean } = {}): RunUndoStep[] {
  return [...actions]
    .filter((a) => a.parentActionId === null && a.status === "succeeded")
    .sort((a, b) => b.seq - a.seq) // newest first
    .flatMap((a): RunUndoStep[] => {
      if (a.reversibility === "read_only") return [];
      if (a.undoStatus === "undone") return [{ actionId: a.id, toolId: a.toolId, kind: "skipped", reason: "already undone" }];
      if (a.reversibility === "compensatable" && !opts.includeCompensations) {
        return [{ actionId: a.id, toolId: a.toolId, kind: "skipped", reason: "compensatable: include_compensations=false" }];
      }
      if (a.reversibility !== "reversible" && a.reversibility !== "compensatable") {
        return [{ actionId: a.id, toolId: a.toolId, kind: "skipped", reason: `${a.reversibility}: cannot be undone` }];
      }
      if (a.undoStatus !== "available" && a.undoStatus !== "conflict" && a.undoStatus !== "failed") {
        return [{ actionId: a.id, toolId: a.toolId, kind: "skipped", reason: `undo ${a.undoStatus}` }];
      }
      return [{ actionId: a.id, toolId: a.toolId, kind: "inverse" }];
    });
}
