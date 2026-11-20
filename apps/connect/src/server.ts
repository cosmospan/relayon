import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { DevKeyProvider } from "@relayon/crypto";
import pg from "pg";
import { createConnectApp } from "./app.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

// Production wires AwsKmsEncryptingProvider here (GenerateDataKey only; no Decrypt in this role).
const keyProvider = DevKeyProvider.fromHex(readFileSync(env("DEV_MASTER_KEY_FILE"), "utf8"));
const app = createConnectApp({
  vault: new pg.Pool({ connectionString: env("CONNECT_VAULT_DATABASE_URL") }),
  keyProvider,
  apiPublicKey: createPublicKey(readFileSync(env("INTERNAL_SIGNING_PUBLIC_KEY_FILE"))),
});
const port = Number(process.env.CONNECT_PORT ?? 8789);
serve({ fetch: app.fetch, port, hostname: process.env.CONNECT_HOST ?? "127.0.0.1" });
console.log(JSON.stringify({ msg: "relayon connect listening", port }));
