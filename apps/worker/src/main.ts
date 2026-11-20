import { Worker } from "bullmq";
import { QUEUES, redisConnectionFromUrl } from "./queues.js";

const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? "redis://localhost:6379");

// Placeholder processors; real handlers land with the hold queue + approval expiry work.
const workers = Object.values(QUEUES).map(
  (name) =>
    new Worker(name, async (job) => {
      console.log(JSON.stringify({ msg: "job received (no-op)", queue: name, jobId: job.id }));
    }, { connection }),
);

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ msg: "relayon worker started", queues: Object.values(QUEUES) }));
