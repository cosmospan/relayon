import { Hono } from "hono";
import { RelayonError } from "@relayon/core";

/** Builds the API app. REST /v1 and MCP /mcp routes are added in the core-relay PR. */
export function createApp() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json(new RelayonError("RELAYON_TOOL_NOT_FOUND", "Route not found").toBody(), 404));

  app.onError((err, c) => {
    if (err instanceof RelayonError) {
      return c.json(err.toBody(), err.status as 400);
    }
    // Never echo internal error text: it can carry upstream data.
    return c.json(new RelayonError("RELAYON_INTERNAL", "Internal error").toBody(), 500);
  });

  return app;
}
