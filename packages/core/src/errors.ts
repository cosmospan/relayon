/** Error codes and HTTP statuses from spec §8.4. */
export const ERROR_HTTP_STATUS = {
  RELAYON_UNAUTHENTICATED: 401,
  RELAYON_FORBIDDEN: 403,
  RELAYON_TOOL_NOT_FOUND: 404,
  RELAYON_INVALID_INPUT: 422,
  RELAYON_CONNECTION_MISSING: 409,
  RELAYON_CONNECTION_EXPIRED: 409,
  RELAYON_POLICY_BLOCKED: 403,
  RELAYON_APPROVAL_REJECTED: 409,
  RELAYON_APPROVAL_EXPIRED: 409,
  RELAYON_SNAPSHOT_FAILED: 424,
  RELAYON_UPSTREAM_ERROR: 502,
  RELAYON_UPSTREAM_RATE_LIMITED: 429,
  RELAYON_RATE_LIMITED: 429,
  RELAYON_IDEMPOTENCY_CONFLICT: 409,
  RELAYON_UNDO_CONFLICT: 409,
  RELAYON_UNDO_NOT_POSSIBLE: 409,
  RELAYON_QUOTA_EXCEEDED: 402,
  RELAYON_INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export interface ErrorBody {
  error: { code: ErrorCode; message: string; action_id?: string; details?: Record<string, unknown> };
}

export class RelayonError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly actionId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts: { actionId?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "RelayonError";
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.actionId = opts.actionId;
    this.details = opts.details;
  }

  toBody(): ErrorBody {
    const error: ErrorBody["error"] = { code: this.code, message: this.message };
    if (this.actionId) error.action_id = this.actionId;
    if (this.details) error.details = this.details;
    return { error };
  }
}
