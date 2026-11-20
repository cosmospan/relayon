import type { z } from "zod";

export type Kind = "read" | "create" | "update" | "delete" | "send" | "pay" | "other";
export type Reversibility = "read_only" | "reversible" | "compensatable" | "irreversible" | "unknown";

export interface TargetRef {
  app: string;
  type: string;
  id?: string;
  url?: string;
  parentId?: string;
}

/** Credential handed to a tool for one call inside the Executor. Never return it. */
export interface ToolCredential {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly apiKey?: string;
}

export interface HttpClient {
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

export interface Ctx<I = unknown> {
  http: HttpClient;
  connection: { id: string };
  credential: ToolCredential | null;
  /** The validated input of the current action (spec §5.2 note). */
  input: I;
  /** Relayon idempotency key to pass upstream where supported: relayon:<action_id>. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface Snapshot<B = unknown> {
  target: TargetRef;
  before: B | null;
  version?: string;
}

export interface DiffField {
  path: string;
  before: unknown;
  after: unknown;
}

export interface Diff {
  target: TargetRef;
  op: "create" | "update" | "delete" | "send" | "other";
  fields: DiffField[];
  summary: string;
}

export interface UndoStep {
  tool: string;
  input: unknown;
  description: string;
}

export interface UndoPlan {
  steps: UndoStep[];
  kind: "inverse" | "compensation";
  caveats?: string[];
}

export interface ExecuteResult<O = unknown> {
  output: O;
  target: TargetRef;
  after?: unknown;
  version?: string;
}

export interface ConflictResult {
  conflict: boolean;
  current?: unknown;
  changedFields?: string[];
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O = unknown> {
  id: string;
  app: string;
  title: string;
  /** Written for LLMs: when to use it and what it does NOT do. */
  description: string;
  kind: Kind;
  reversibility: Reversibility;
  input: I;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  resolveTarget(input: z.infer<I>, ctx: Ctx<z.infer<I>>): Promise<TargetRef>;
  preview?(input: z.infer<I>, snap: Snapshot | null, ctx: Ctx<z.infer<I>>): Promise<Diff>;
  snapshot?(target: TargetRef, ctx: Ctx<z.infer<I>>): Promise<Snapshot>;
  execute(input: z.infer<I>, ctx: Ctx<z.infer<I>>): Promise<ExecuteResult<O>>;
  planUndo?(args: { input: z.infer<I>; before: Snapshot; output: O; target: TargetRef }): UndoPlan;
  conflictCheck?(args: { target: TargetRef; afterVersion?: string; after?: unknown }, ctx: Ctx<z.infer<I>>): Promise<ConflictResult>;
}

export function defineTool<I extends z.ZodType, O>(t: ToolDef<I, O>): ToolDef<I, O> {
  return t;
}

export interface ConnectorDef {
  app: string;
  displayName: string;
  auth: { type: "none" | "api_key" | "oauth2" | "github_app" };
  /** Domains this connector may reach through safeFetch (§11.9). */
  allowHosts: readonly string[];
  baseUrl?: string;
  rateLimit?: { capacity: number; refillPerSec: number };
  tools: ToolDef<z.ZodType, unknown>[];
}
