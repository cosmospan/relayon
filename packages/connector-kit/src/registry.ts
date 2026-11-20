import { RelayonError } from "@relayon/core";
import { z } from "zod";
import type { ConnectorDef, ToolDef } from "./types.js";

export interface ToolInfo {
  id: string;
  app: string;
  name: string;
  title: string;
  description: string;
  kind: string;
  reversibility: string;
  source: "native";
  inputSchema: Record<string, unknown>;
  annotations?: ToolDef["annotations"];
}

/** MCP tool names allow [a-zA-Z0-9_-]; ids use dots. */
export function mcpName(id: string): string {
  return id.replace(/\./g, "_");
}

export class ConnectorRegistry {
  readonly #connectors = new Map<string, ConnectorDef>();
  readonly #tools = new Map<string, ToolDef>();
  readonly #byMcpName = new Map<string, string>();

  register(c: ConnectorDef): this {
    if (this.#connectors.has(c.app)) throw new Error(`connector ${c.app} already registered`);
    this.#connectors.set(c.app, c);
    for (const t of c.tools) {
      if (t.app !== c.app || !t.id.startsWith(`${c.app}.`)) throw new Error(`tool ${t.id} does not belong to ${c.app}`);
      if (this.#tools.has(t.id)) throw new Error(`duplicate tool ${t.id}`);
      this.#tools.set(t.id, t);
      this.#byMcpName.set(mcpName(t.id), t.id);
    }
    return this;
  }

  connector(app: string): ConnectorDef | undefined {
    return this.#connectors.get(app);
  }

  tool(id: string): ToolDef {
    const t = this.#tools.get(id) ?? this.#tools.get(this.#byMcpName.get(id) ?? "");
    if (!t) throw new RelayonError("RELAYON_TOOL_NOT_FOUND", `Unknown tool ${id}`);
    return t;
  }

  has(id: string): boolean {
    return this.#tools.has(id) || this.#byMcpName.has(id);
  }

  list(filter: { app?: string; kind?: string } = {}): ToolInfo[] {
    return [...this.#tools.values()]
      .filter((t) => (!filter.app || t.app === filter.app) && (!filter.kind || t.kind === filter.kind))
      .map((t) => ({
        id: t.id,
        app: t.app,
        name: mcpName(t.id),
        title: t.title,
        description: t.description,
        kind: t.kind,
        reversibility: t.reversibility,
        source: "native" as const,
        inputSchema: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
  }

  /** Validates input strictly (unknown fields rejected by the tool's schema). */
  parseInput(id: string, input: unknown): unknown {
    const t = this.tool(id);
    const r = t.input.safeParse(input);
    if (!r.success) throw new RelayonError("RELAYON_INVALID_INPUT", "Input does not match the tool schema", { details: { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
    return r.data;
  }
}
