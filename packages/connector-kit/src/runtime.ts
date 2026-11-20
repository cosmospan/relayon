import { RelayonError } from "@relayon/core";
import { createHttpClient } from "./http.js";
import type { ConnectorRegistry } from "./registry.js";
import type { Ctx, TargetRef, ToolCredential } from "./types.js";

export interface RuntimeInvocation {
  op: string;
  toolId: string;
  actionId: string;
  connectionId: string;
  input: unknown;
  params: unknown;
  credential: ToolCredential | null;
}

export type RuntimeOp = "preview" | "snapshot" | "execute" | "undo_check";

/**
 * Connector runtime used ONLY inside the Executor. Dispatches one op to the tool definition with
 * a Ctx whose HTTP client is safeFetch-only, allowlisted to the connector's domains.
 */
export function createToolRuntime(registry: ConnectorRegistry, opts: { authHeader?: (app: string, c: ToolCredential) => Record<string, string> } = {}) {
  return {
    async run(inv: RuntimeInvocation): Promise<unknown> {
      const tool = registry.tool(inv.toolId);
      const connector = registry.connector(tool.app)!;
      const input = registry.parseInput(tool.id, inv.input);
      const ctx: Ctx = {
        http: createHttpClient({
          baseUrl: connector.baseUrl ?? "https://invalid.invalid/",
          allowHosts: connector.allowHosts,
          credential: inv.credential,
          authHeader: opts.authHeader ? (c) => opts.authHeader!(tool.app, c) : undefined,
        }),
        connection: { id: inv.connectionId },
        credential: inv.credential,
        input,
        idempotencyKey: `relayon:${inv.actionId}`,
        signal: AbortSignal.timeout(30_000),
      };
      switch (inv.op as RuntimeOp) {
        case "preview": {
          const target = await tool.resolveTarget(input, ctx);
          const snap = tool.snapshot ? await tool.snapshot(target, ctx) : null;
          const diff = tool.preview
            ? await tool.preview(input, snap, ctx)
            : { target, op: tool.kind === "create" || tool.kind === "update" || tool.kind === "delete" || tool.kind === "send" ? tool.kind : "other", fields: [], summary: tool.title };
          return { target, diff };
        }
        case "snapshot": {
          const target = await tool.resolveTarget(input, ctx);
          if (!tool.snapshot) return { target, before: null };
          return await tool.snapshot(target, ctx);
        }
        case "execute":
          return await tool.execute(input, ctx);
        case "undo_check": {
          if (!tool.conflictCheck) return { conflict: false };
          const p = (inv.params ?? {}) as { target?: TargetRef; after?: unknown; version?: string };
          if (!p.target) throw new RelayonError("RELAYON_INVALID_INPUT", "undo_check needs a target");
          return await tool.conflictCheck({ target: p.target, after: p.after, afterVersion: p.version }, ctx);
        }
        default:
          throw new RelayonError("RELAYON_FORBIDDEN", `Unsupported op ${inv.op}`);
      }
    },
  };
}
