/**
 * Action state machine, spec §4.1. Persistence must apply transitions with
 * `UPDATE … WHERE id = $1 AND status = $expected` so that only one worker wins.
 */
export const ACTION_STATUSES = [
  "received",
  "previewed",
  "blocked",
  "executing",
  "succeeded",
  "failed",
  "held",
  "cancelled",
  "pending_approval",
  "approved",
  "rejected",
  "expired",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  // received/previewed → failed covers "could not preview / resolve the target" (fail closed).
  received: ["previewed", "failed"],
  previewed: ["blocked", "executing", "held", "pending_approval", "failed"],
  executing: ["succeeded", "failed"],
  held: ["executing", "cancelled"],
  pending_approval: ["approved", "rejected", "expired"],
  approved: ["executing"],
  blocked: [],
  succeeded: [],
  failed: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ActionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
