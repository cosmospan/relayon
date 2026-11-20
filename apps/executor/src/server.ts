import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { DekCache, DevKeyProvider } from "@relayon/crypto";
import pg from "pg";
import { createExecutorApp } from "./app.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

// Production wires AwsKmsDecryptingProvider (this is the only role with kms:Decrypt).
const keyProvider = DevKeyProvider.fromHex(readFileSync(env("DEV_MASTER_KEY_FILE"), "utf8"));
const app = createExecutorApp({
  mainRo: new pg.Pool({ connectionString: env("EXECUTOR_MAIN_DATABASE_URL") }),
  vault: new pg.Pool({ connectionString: env("EXECUTOR_VAULT_DATABASE_URL") }),
  dekCache: new DekCache(keyProvider),
  trustedSigners: [createPublicKey(readFileSync(env("INTERNAL_SIGNING_PUBLIC_KEY_FILE")))],
  runtime: { run: async () => { throw new Error("no connectors registered"); } },
  instanceId: `${hostname()}:${process.pid}`,
});
const port = Number(process.env.EXECUTOR_PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: process.env.EXECUTOR_HOST ?? "127.0.0.1" });
console.log(JSON.stringify({ msg: "relayon executor listening", port }));
