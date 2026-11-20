import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("api app", () => {
  it("serves /healthz", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns the spec error shape for unknown routes", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "RELAYON_TOOL_NOT_FOUND" } });
  });
});
