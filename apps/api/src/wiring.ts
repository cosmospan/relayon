import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConnectorRegistry } from "@relayon/connector-kit";
import { createDemoConnector } from "@relayon/connector-demo";
import { RelayonError } from "@relayon/core";
import { ExecutorClient, Relay, SnapshotSealer, type ExecutorTransport, type HoldScheduler } from "@relayon/engine";
import { createInternalClient } from "@relayon/net";
import type pg from "pg";

export function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
}

export function hexFile(path: string, bytes = 32): Buffer {
  const hex = readFileSync(path, "utf8").trim();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(hex)) throw new Error(`${path} must hold ${bytes} bytes of hex`);
  return Buffer.from(hex, "hex");
}

export function loadSigningKey(): KeyObject {
  return createPrivateKey(readFileSync(env("INTERNAL_SIGNING_KEY_FILE")));
}

/** The connectors the platform ships (§5). Real apps are added here as they are built. */
export function createRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register(createDemoConnector());
}

/** HTTP transport to the Executor (production adds mTLS on this client). */
export function httpExecutorTransport(baseUrl: string): ExecutorTransport {
  const post = createInternalClient(baseUrl);
  return {
    async exec(token, params) {
      const res = await post("/internal/exec", { "x-relayon-exec": token }, { params });
      if (res.status !== 200) {
        const e = (res.json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
        throw new RelayonError((e?.code as never) ?? "RELAYON_INTERNAL", e?.message ?? "Executor error", { details: e?.details });
      }
      return (res.json as { result: unknown }).result;
    },
  };
}

export function createRelay(pool: pg.Pool, transport: ExecutorTransport, holds: HoldScheduler, signingKey: KeyObject, snapshotKey: Buffer) {
  return new Relay({
    pool,
    registry: createRegistry(),
    executor: new ExecutorClient(transport, signingKey),
    sealer: new SnapshotSealer(snapshotKey),
    holds,
  });
}
