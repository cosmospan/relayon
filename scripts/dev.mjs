// Runs the API, Executor, Connect and Worker locally with .env loaded. Ctrl+C stops all of them.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env")) {
  console.error("No .env: run `cp .env.example .env` and `pnpm dev:keys` first.");
  process.exit(1);
}
const services = [
  ["executor", "apps/executor/dist/server.js"],
  ["connect", "apps/connect/dist/server.js"],
  ["api", "apps/api/dist/server.js"],
  ["worker", "apps/worker/dist/main.js"],
];
const children = services.map(([name, entry]) => {
  const child = spawn(process.execPath, ["--env-file=.env", entry], { stdio: ["ignore", "pipe", "pipe"] });
  const tag = (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout.on("data", tag);
  child.stderr.on("data", tag);
  child.on("exit", (code) => console.log(`[${name}] exited with ${code}`));
  return child;
});
const stop = () => { for (const c of children) c.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
