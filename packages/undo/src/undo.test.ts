import { describe, expect, it } from "vitest";
import { planRunUndo, type UndoCandidate } from "./index.js";

const a = (id: string, seq: number, over: Partial<UndoCandidate> = {}): UndoCandidate => ({
  id, seq, toolId: "demo.update_record", reversibility: "reversible", undoStatus: "available", status: "succeeded", parentActionId: null, ...over,
});

describe("planRunUndo", () => {
  it("orders newest first and skips what cannot or should not be undone", () => {
    const plan = planRunUndo([
      a("a1", 1),
      a("a2", 2, { reversibility: "read_only" }),
      a("a3", 3, { reversibility: "irreversible", toolId: "demo.send_message", undoStatus: "not_possible" }),
      a("a4", 4, { reversibility: "compensatable" }),
      a("a5", 5, { status: "failed" }),
      a("a6", 6, { parentActionId: "a1" }),
      a("a7", 7, { undoStatus: "undone" }),
      a("a8", 8),
    ]);
    expect(plan).toEqual([
      { actionId: "a8", toolId: "demo.update_record", kind: "inverse" },
      { actionId: "a7", toolId: "demo.update_record", kind: "skipped", reason: "already undone" },
      { actionId: "a4", toolId: "demo.update_record", kind: "skipped", reason: "compensatable: include_compensations=false" },
      { actionId: "a3", toolId: "demo.send_message", kind: "skipped", reason: "irreversible: cannot be undone" },
      { actionId: "a1", toolId: "demo.update_record", kind: "inverse" },
    ]);
  });

  it("includes compensations when asked", () => {
    expect(planRunUndo([a("c", 1, { reversibility: "compensatable" })], { includeCompensations: true })[0]!.kind).toBe("inverse");
  });
});
