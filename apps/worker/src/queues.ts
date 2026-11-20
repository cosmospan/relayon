/** Queue names, spec §3.2. The worker has NO decrypt rights: provider calls go to apps/executor. */
export const QUEUES = {
  holds: "holds",
  approvalsExpiry: "approvals-expiry",
  undoRuns: "undo-runs",
  webhooksOut: "webhooks-out",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function redisConnectionFromUrl(url: string): { host: string; port: number; username?: string; password?: string; tls?: object } {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error(`Unsupported Redis URL protocol: ${u.protocol}`);
  const conn: { host: string; port: number; username?: string; password?: string; tls?: object } = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.username) conn.username = decodeURIComponent(u.username);
  if (u.password) conn.password = decodeURIComponent(u.password);
  if (u.protocol === "rediss:") conn.tls = {};
  return conn;
}
