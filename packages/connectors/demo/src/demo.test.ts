import { ConnectorRegistry, createToolRuntime } from "@relayon/connector-kit";
import { describe, expect, it } from "vitest";
import { createDemoConnector } from "./index.js";

const demo = createDemoConnector();
const registry = new ConnectorRegistry().register(demo);
const runtime = createToolRuntime(registry);
const run = (op: string, toolId: string, input: unknown, params: unknown = null) =>
  runtime.run({ op, toolId, input, params, actionId: "act_x", connectionId: "con_1", credential: null }) as Promise<Record<string, unknown>>;

describe("demo connector via the tool runtime", () => {
  it("lists tools with JSON schemas and MCP-safe names", () => {
    const tools = registry.list();
    expect(tools.map((t) => t.name)).toContain("demo_update_record");
    const upd = tools.find((t) => t.id === "demo.update_record")!;
    expect(upd.inputSchema).toMatchObject({ type: "object", required: ["id", "changes"] });
  });

  it("previews, snapshots, executes and plans an inverse undo for an update", async () => {
    const created = (await run("execute", "demo.create_record", { title: "Acme" })).output as { id: string };
    const input = { id: created.id, changes: { status: "won" } };
    const pv = await run("preview", "demo.update_record", input);
    expect(pv.diff).toMatchObject({ op: "update", fields: [{ path: "status", before: "open", after: "won" }] });
    const snap = await run("snapshot", "demo.update_record", input);
    expect(snap.before).toEqual({ status: "open" });
    const ex = await run("execute", "demo.update_record", input);
    const tool = registry.tool("demo.update_record");
    const plan = tool.planUndo!({ input, before: snap as never, output: ex.output, target: ex.target as never });
    expect(plan.steps[0]).toMatchObject({ tool: "demo.update_record", input: { id: created.id, changes: { status: "open" } } });
    expect(await run("undo_check", "demo.update_record", input, { target: ex.target, after: ex.after, version: ex.version })).toEqual({ conflict: false, current: { status: "won" }, changedFields: [] });
    // A human changes the same field → conflict.
    demo.store.put("con_1", { ...demo.store.get("con_1", created.id)!, status: "lost" });
    expect(await run("undo_check", "demo.update_record", input, { target: ex.target, after: ex.after })).toMatchObject({ conflict: true, changedFields: ["status"] });
  });

  it("rejects unknown input fields", async () => {
    await expect(run("execute", "demo.create_record", { title: "x", evil: 1 })).rejects.toThrow(/schema/);
  });

  it("isolates records per connection", async () => {
    const r = (await run("execute", "demo.create_record", { title: "A" })).output as { id: string };
    await expect(runtime.run({ op: "execute", toolId: "demo.get_record", input: { id: r.id }, params: null, actionId: "a", connectionId: "con_2", credential: null })).rejects.toThrow(/not found/);
  });
});
