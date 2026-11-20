import { RelayonError } from "@relayon/core";
import { Hono } from "hono";
import { handleExec, type ExecutorDeps } from "./executor.js";

export function createExecutorApp(deps: ExecutorDeps) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.post("/internal/exec", async (c) => {
    const token = c.req.header("x-relayon-exec") ?? "";
    let body: { params?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }
    try {
      return c.json(await handleExec(deps, token, body.params ?? null));
    } catch (err) {
      const e = err instanceof RelayonError ? err : new RelayonError("RELAYON_INTERNAL", "Internal error");
      return c.json(e.toBody(), e.status as 400);
    }
  });
  return app;
}
