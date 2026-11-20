import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID (time-sortable, 80 bits of randomness), spec §4 conventions. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

export const ID_PREFIXES = {
  org: "org",
  user: "usr",
  project: "prj",
  apiKey: "key",
  endUser: "eu",
  connection: "con",
  credential: "cred",
  dek: "dek",
  run: "run",
  action: "act",
  snapshot: "snp",
  undo: "undo",
  policy: "pol",
  approval: "apr",
  upstream: "ups",
  webhook: "whk",
  delivery: "dlv",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid().toLowerCase()}`;
}
