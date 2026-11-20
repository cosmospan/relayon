import { describe, expect, it } from "vitest";
import { QUEUES, redisConnectionFromUrl } from "./queues.js";

describe("worker queues", () => {
  it("defines the four v1 queues", () => {
    expect(Object.values(QUEUES).sort()).toEqual(["approvals-expiry", "holds", "undo-runs", "webhooks-out"]);
  });

  it("parses redis URLs", () => {
    expect(redisConnectionFromUrl("redis://localhost:6379")).toEqual({ host: "localhost", port: 6379 });
    expect(redisConnectionFromUrl("rediss://u:p%40ss@cache:6380")).toEqual({ host: "cache", port: 6380, username: "u", password: "p@ss", tls: {} });
    expect(() => redisConnectionFromUrl("http://x")).toThrow();
  });
});
