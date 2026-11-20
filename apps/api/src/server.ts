import { serve } from "@hono/node-server";
import { createInternalClient } from "@relayon/net";
import { Queue } from "bullmq";
import pg from "pg";
import { createApp } from "./app.js";
import { createRelay, env, hexFile, httpExecutorTransport, loadSigningKey } from "./wiring.js";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const holdsQueue = new Queue("holds", { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}) } });

const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 20 });
const signingKey = loadSigningKey();
const relay = createRelay(
  pool,
  httpExecutorTransport(env("EXECUTOR_URL")),
  {
    // Job payloads hold ids only (§11.3 worker row). jobId = action id makes scheduling idempotent.
    schedule: async (j) => {
      await holdsQueue.add("hold", { orgId: j.orgId, projectId: j.projectId, actionId: j.actionId }, { jobId: j.actionId, delay: Math.max(0, j.executeAt.getTime() - Date.now()), removeOnComplete: true, removeOnFail: 1000 });
    },
  },
  signingKey,
  hexFile(env("SNAPSHOT_KEY_FILE")),
);

const app = createApp({
  pool,
  pepper: hexFile(env("API_KEY_PEPPER_FILE")),
  relay,
  connect: { post: createInternalClient(env("CONNECT_URL")), signingKey },
  allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(JSON.stringify({ msg: "relayon api listening", port, rest: "/v1", mcp: "/mcp" }));
