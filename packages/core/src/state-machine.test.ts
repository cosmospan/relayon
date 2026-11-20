import { describe, expect, it } from "vitest";
import { ACTION_STATUSES, RelayonError, canTransition, isTerminal } from "./index.js";

describe("action state machine (§4.1)", () => {
  it.each([
    ["received", "previewed"],
    ["received", "failed"],
    ["previewed", "failed"],
    ["previewed", "blocked"],
    ["previewed", "executing"],
    ["previewed", "held"],
    ["previewed", "pending_approval"],
    ["held", "executing"],
    ["held", "cancelled"],
    ["pending_approval", "approved"],
    ["pending_approval", "rejected"],
    ["pending_approval", "expired"],
    ["approved", "executing"],
    ["executing", "succeeded"],
    ["executing", "failed"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ["received", "executing"],
    ["pending_approval", "executing"],
    ["held", "succeeded"],
    ["succeeded", "executing"],
    ["cancelled", "executing"],
  ] as const)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("marks exactly the end states as terminal", () => {
    const terminal = ACTION_STATUSES.filter(isTerminal).sort();
    expect(terminal).toEqual(["blocked", "cancelled", "expired", "failed", "rejected", "succeeded"]);
  });
});

describe("RelayonError (§8.4)", () => {
  it("maps codes to HTTP status and serialises the error body", () => {
    const err = new RelayonError("RELAYON_POLICY_BLOCKED", "blocked by rule r1", { actionId: "act_1" });
    expect(err.status).toBe(403);
    expect(err.toBody()).toEqual({ error: { code: "RELAYON_POLICY_BLOCKED", message: "blocked by rule r1", action_id: "act_1" } });
  });
});
