import { RelayonError } from "@relayon/core";
import { defineTool, type ConnectorDef, type Ctx, type TargetRef } from "@relayon/connector-kit";
import { z } from "zod";
import { DemoStore, type DemoRecord } from "./store.js";

export { DemoStore, type DemoRecord } from "./store.js";

const FIELDS = ["title", "status", "body"] as const;

const notFound = (id: string) => new RelayonError("RELAYON_UPSTREAM_ERROR", `Record ${id} not found`, { details: { upstream_status: 404 } });

/** Builds the demo connector around a store (tests can inject their own and simulate humans). */
export function createDemoConnector(store = new DemoStore()): ConnectorDef & { store: DemoStore } {
  const target = (id?: string): TargetRef => ({ app: "demo", type: "record", ...(id ? { id } : {}) });
  const pick = (r: DemoRecord | undefined, keys: readonly string[]) =>
    r ? Object.fromEntries(keys.map((k) => [k, (r as unknown as Record<string, unknown>)[k] ?? null])) : null;
  const conn = (ctx: Ctx) => ctx.connection.id;

  const getRecord = defineTool({
    id: "demo.get_record", app: "demo", title: "Get a demo record",
    description: "Read one record by id. Does not change anything.",
    kind: "read", reversibility: "read_only",
    input: z.object({ id: z.string().min(1).max(64) }).strict(),
    annotations: { readOnlyHint: true },
    async resolveTarget(i) { return target(i.id); },
    async execute(i, ctx) {
      const r = store.get(conn(ctx), i.id);
      if (!r || r.trashed) throw notFound(i.id);
      return { output: r, target: target(i.id) };
    },
  });

  const listRecords = defineTool({
    id: "demo.list_records", app: "demo", title: "List demo records",
    description: "List records that are not in the trash. Does not change anything.",
    kind: "read", reversibility: "read_only",
    input: z.object({}).strict(),
    annotations: { readOnlyHint: true },
    async resolveTarget() { return target(); },
    async execute(_i, ctx) { return { output: { records: store.list(conn(ctx)) }, target: target() }; },
  });

  const createRecord = defineTool({
    id: "demo.create_record", app: "demo", title: "Create a demo record",
    description: "Create one new record. Does not update or delete existing records.",
    kind: "create", reversibility: "reversible",
    input: z.object({ title: z.string().min(1).max(200), status: z.string().max(50).default("open"), body: z.string().max(10_000).default("") }).strict(),
    async resolveTarget() { return target(); },
    async snapshot(t) { return { target: t, before: null }; },
    async preview(i) {
      return { target: target(), op: "create", summary: `Create record "${i.title}"`, fields: FIELDS.map((f) => ({ path: f, before: null, after: i[f] })) };
    },
    async execute(i, ctx) {
      const r = store.put(conn(ctx), { id: store.nextId("rec"), title: i.title, status: i.status, body: i.body, trashed: false, version: 1 });
      return { output: r, target: target(r.id), after: pick(r, [...FIELDS, "trashed"]), version: String(r.version) };
    },
    planUndo({ output }) {
      return { kind: "inverse", steps: [{ tool: "demo.delete_record", input: { id: (output as DemoRecord).id }, description: "Move the created record to the trash" }] };
    },
    async conflictCheck({ target: t, after }, ctx) {
      // Compare field values, not versions: later writes in the same run that were already undone
      // bump the version but leave the record as the agent created it.
      const cur = store.get(conn(ctx), t.id!);
      if (!cur) return { conflict: false };
      const a = (after ?? {}) as Record<string, unknown>;
      const changed = Object.keys(a).filter((k) => (cur as unknown as Record<string, unknown>)[k] !== a[k]);
      return { conflict: changed.length > 0, current: pick(cur, Object.keys(a)), changedFields: changed };
    },
  });

  const updateRecord = defineTool({
    id: "demo.update_record", app: "demo", title: "Update a demo record",
    description: "Change title, status or body of one existing record. Does not create or delete records.",
    kind: "update", reversibility: "reversible",
    input: z.object({
      id: z.string().min(1).max(64),
      changes: z.object({ title: z.string().min(1).max(200).optional(), status: z.string().max(50).optional(), body: z.string().max(10_000).optional() }).strict()
        .refine((c) => Object.keys(c).length > 0, "at least one field"),
    }).strict(),
    annotations: { idempotentHint: true },
    async resolveTarget(i) { return target(i.id); },
    async snapshot(t, ctx) {
      const keys = Object.keys((ctx.input as { changes: object }).changes);
      const r = store.get(conn(ctx), t.id!);
      if (!r || r.trashed) throw notFound(t.id!);
      return { target: t, before: pick(r, keys), version: String(r.version) };
    },
    async preview(i, snap) {
      const before = (snap?.before ?? {}) as Record<string, unknown>;
      return {
        target: target(i.id), op: "update", summary: `Update record ${i.id}`,
        fields: Object.entries(i.changes).map(([k, v]) => ({ path: k, before: before[k] ?? null, after: v })),
      };
    },
    async execute(i, ctx) {
      const cur = store.get(conn(ctx), i.id);
      if (!cur || cur.trashed) throw notFound(i.id);
      const next = store.put(conn(ctx), { ...cur, ...i.changes, version: cur.version + 1 });
      return { output: next, target: target(i.id), after: pick(next, Object.keys(i.changes)), version: String(next.version) };
    },
    planUndo({ input, before }) {
      const restore = Object.fromEntries(Object.keys(input.changes).map((k) => [k, (before.before as Record<string, unknown>)[k]]));
      return { kind: "inverse", steps: [{ tool: "demo.update_record", input: { id: input.id, changes: restore }, description: `Restore ${Object.keys(restore).join(", ")}` }] };
    },
    async conflictCheck({ target: t, after }, ctx) {
      const cur = store.get(conn(ctx), t.id!);
      if (!cur) return { conflict: true, changedFields: ["(deleted)"] };
      const a = (after ?? {}) as Record<string, unknown>;
      const changed = Object.keys(a).filter((k) => (cur as unknown as Record<string, unknown>)[k] !== a[k]);
      return { conflict: changed.length > 0, current: pick(cur, Object.keys(a)), changedFields: changed };
    },
  });

  const deleteRecord = defineTool({
    id: "demo.delete_record", app: "demo", title: "Delete a demo record",
    description: "Move one record to the trash. It can be restored. Does not delete permanently.",
    kind: "delete", reversibility: "reversible",
    input: z.object({ id: z.string().min(1).max(64) }).strict(),
    annotations: { destructiveHint: true },
    async resolveTarget(i) { return target(i.id); },
    async snapshot(t, ctx) {
      const r = store.get(conn(ctx), t.id!);
      if (!r) throw notFound(t.id!);
      return { target: t, before: pick(r, [...FIELDS, "trashed"]), version: String(r.version) };
    },
    async preview(i, snap) {
      const b = (snap?.before ?? {}) as Record<string, unknown>;
      return { target: target(i.id), op: "delete", summary: `Delete record "${String(b.title ?? i.id)}"`, fields: [{ path: "trashed", before: b.trashed ?? false, after: true }] };
    },
    async execute(i, ctx) {
      const cur = store.get(conn(ctx), i.id);
      if (!cur) throw notFound(i.id);
      const next = store.put(conn(ctx), { ...cur, trashed: true, version: cur.version + 1 });
      return { output: { id: i.id, trashed: true }, target: target(i.id), after: { trashed: true }, version: String(next.version) };
    },
    planUndo({ input }) {
      return { kind: "inverse", steps: [{ tool: "demo.restore_record", input: { id: input.id }, description: "Restore the record from the trash" }] };
    },
    async conflictCheck({ target: t }, ctx) {
      const cur = store.get(conn(ctx), t.id!);
      return { conflict: !cur || !cur.trashed, changedFields: !cur || !cur.trashed ? ["trashed"] : [] };
    },
  });

  const restoreRecord = defineTool({
    id: "demo.restore_record", app: "demo", title: "Restore a demo record",
    description: "Restore one record from the trash. Does not change its fields.",
    kind: "update", reversibility: "reversible",
    input: z.object({ id: z.string().min(1).max(64) }).strict(),
    async resolveTarget(i) { return target(i.id); },
    async snapshot(t, ctx) {
      const r = store.get(conn(ctx), t.id!);
      if (!r) throw notFound(t.id!);
      return { target: t, before: { trashed: r.trashed }, version: String(r.version) };
    },
    async execute(i, ctx) {
      const cur = store.get(conn(ctx), i.id);
      if (!cur) throw notFound(i.id);
      const next = store.put(conn(ctx), { ...cur, trashed: false, version: cur.version + 1 });
      return { output: next, target: target(i.id), after: { trashed: false }, version: String(next.version) };
    },
    planUndo({ input }) {
      return { kind: "inverse", steps: [{ tool: "demo.delete_record", input: { id: input.id }, description: "Move the record back to the trash" }] };
    },
  });

  const sendMessage = defineTool({
    id: "demo.send_message", app: "demo", title: "Send a demo message",
    description: "Send a message to someone. It cannot be unsent. Does not create records.",
    kind: "send", reversibility: "irreversible",
    input: z.object({ to: z.string().min(1).max(200), text: z.string().min(1).max(5000) }).strict(),
    async resolveTarget(i) { return { app: "demo", type: "message", parentId: i.to }; },
    async preview(i) {
      return { target: { app: "demo", type: "message" }, op: "send", summary: `Send a message to ${i.to}`, fields: [{ path: "text", before: null, after: i.text }] };
    },
    async execute(i, ctx) {
      const m = store.send(conn(ctx), i.to, i.text);
      return { output: m, target: { app: "demo", type: "message", id: m.id } };
    },
  });

  return {
    app: "demo",
    displayName: "Demo app",
    auth: { type: "none" },
    allowHosts: [],
    tools: [getRecord, listRecords, createRecord, updateRecord, deleteRecord, restoreRecord, sendMessage] as unknown as ConnectorDef["tools"],
    store,
  };
}
