import { createRelay, env, hexFile, httpExecutorTransport, loadSigningKey } from "@relayon/api";
import { Queue, Worker } from "bullmq";
import pg from "pg";
import { QUEUES, redisConnectionFromUrl } from "./queues.js";

/**
 * Worker: runs held actions when their hold expires, and sweeps (every 30 s) for holds whose job
 * was lost and approvals that expired (§7.5). It has NO decrypt rights: provider calls go to the
 * Executor through signed requests, exactly like the API.
 */
const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? "redis://localhost:6379");
const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 10 });
const relay = createRelay(pool, httpExecutorTransport(env("EXECUTOR_URL")), { schedule: async () => undefined }, loadSigningKey(), hexFile(env("SNAPSHOT_KEY_FILE")));

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

const holds = new Worker<{ orgId: string; projectId: string; actionId: string }>(
  QUEUES.holds,
  async (job) => {
    const { orgId, projectId, actionId } = job.data;
    const r = await relay.runHeld({ orgId, projectId }, actionId);
    log({ msg: "hold processed", actionId, result: r });
  },
  { connection, concurrency: 10 },
);

const sweeperQueue = new Queue("sweeper", { connection });
await sweeperQueue.upsertJobScheduler("sweep-every-30s", { every: 30_000 }, { name: "sweep" });
const sweeper = new Worker(
  "sweeper",
  async () => {
    const h = await relay.sweepHolds();
    const a = await relay.expireApprovals();
    if (h || a) log({ msg: "sweep", holdsExecuted: h, approvalsExpired: a });
  },
  { connection, concurrency: 1 },
);

const shutdown = async () => {
  await Promise.all([holds.close(), sweeper.close(), sweeperQueue.close()]);
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
log({ msg: "relayon worker started", queues: [QUEUES.holds, "sweeper"] });
