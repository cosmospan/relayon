import type { KeyObject } from "node:crypto";
import { signRequest } from "@relayon/crypto";

/** Transport to the isolated Executor. In production: mTLS HTTP. In tests: in-process. */
export interface ExecutorTransport {
  exec(token: string, params: unknown): Promise<unknown>;
}

export interface ExecTarget {
  orgId: string;
  projectId: string;
  connectionId: string | null;
  actionId: string;
  toolId: string;
  inputHash: Buffer;
}

/** Signs one single-use exec request (§11.2) per call. The engine never sees credentials. */
export class ExecutorClient {
  constructor(private readonly transport: ExecutorTransport, private readonly signingKey: KeyObject) {}

  async run<T = unknown>(op: "preview" | "snapshot" | "execute" | "undo_check", t: ExecTarget, params: unknown = null): Promise<T> {
    const token = signRequest(this.signingKey, {
      aud: "executor",
      org_id: t.orgId,
      project_id: t.projectId,
      connection_id: t.connectionId ?? "none",
      op,
      action_id: t.actionId,
      tool_id: t.toolId,
      input_hash: t.inputHash.toString("hex"),
    });
    return (await this.transport.exec(token, params)) as T;
  }
}
