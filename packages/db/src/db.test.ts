import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintRls, newId, ulid, withTenant } from "./index.js";
import { createTenant, setupMainDb } from "./testing/index.js";

let pools: Awaited<ReturnType<typeof setupMainDb>>;
let a: { orgId: string; projectId: string };
let b: { orgId: string; projectId: string };

async function insertAction(pool: pg.Pool, t: { orgId: string; projectId: string }) {
  const id = newId("action");
  await withTenant(pool, t, (db) =>
    db.query(
      `insert into actions(id, org_id, project_id, tool_id, source, caller, input, input_hash, kind, reversibility, policy_decision, status)
       values ($1,$2,$3,'demo.update_record','native','rest','{}',$4,'update','reversible','allow','received')`,
      [id, t.orgId, t.projectId, createHash("sha256").update(id).digest()],
    ),
  );
  return id;
}

beforeAll(async () => {
  pools = await setupMainDb();
  a = await createTenant(pools.owner, "a");
  b = await createTenant(pools.owner, "b");
});

afterAll(async () => {
  await Promise.all([pools.owner.end(), pools.app.end(), pools.executor.end()]);
});

describe("ids", () => {
  it("are prefixed, lowercase and time-sortable", () => {
    expect(newId("action")).toMatch(/^act_[0-9a-z]{26}$/);
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });
});

describe("RLS migration lint (§11.5)", () => {
  it("finds every tenant table with RLS enabled, forced and a policy", async () => {
    const client = await pools.owner.connect();
    try {
      expect(await lintRls(client)).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe("tenant isolation (§11.5)", () => {
  it("returns zero rows when app.org_id is unset", async () => {
    await insertAction(pools.app, a);
    const client = await pools.app.connect();
    try {
      const tables = (await client.query<{ table_name: string }>(
        `select table_name from information_schema.columns where table_schema='public' and column_name='org_id'`,
      )).rows.map((r) => r.table_name);
      expect(tables.length).toBeGreaterThan(20);
      for (const t of [...tables, "orgs", "users"]) {
        const { rows } = await client.query(`select count(*)::int as n from ${t}`);
        expect({ t, n: rows[0].n }).toEqual({ t, n: 0 });
      }
    } finally {
      client.release();
    }
  });

  it("org B cannot read, update or write org A's rows", async () => {
    const actA = await insertAction(pools.app, a);
    await withTenant(pools.app, b, async (db) => {
      expect((await db.query("select id from actions where id = $1", [actA])).rowCount).toBe(0);
      expect((await db.query("update actions set status='previewed' where id = $1", [actA])).rowCount).toBe(0);
      expect((await db.query("select id from projects where id = $1", [a.projectId])).rowCount).toBe(0);
      expect((await db.query("select id from orgs where id = $1", [a.orgId])).rowCount).toBe(0);
    });
    await expect(
      withTenant(pools.app, b, (db) =>
        db.query(`insert into connections(id, org_id, project_id, app, auth_type) values ($1, $2, $3, 'demo', 'none')`, [newId("connection"), a.orgId, a.projectId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("app role is not the owner and cannot bypass RLS", async () => {
    const { rows } = await pools.app.query(
      `select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("ledger is append-only", () => {
  it("app role cannot delete actions", async () => {
    const id = await insertAction(pools.app, a);
    await expect(withTenant(pools.app, a, (db) => db.query("delete from actions where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("immutable columns cannot change", async () => {
    const id = await insertAction(pools.app, a);
    await expect(
      withTenant(pools.app, a, (db) => db.query(`update actions set input = '{"x":1}' where id = $1`, [id])),
    ).rejects.toThrow(/immutable/);
    await withTenant(pools.app, a, (db) => db.query(`update actions set status = 'previewed' where id = $1`, [id]));
  });
});

describe("api key lookup before tenant context", () => {
  it("finds a key only by prefix through the security-definer function", async () => {
    const prefix = `rl_live_${ulid().slice(-8).toLowerCase()}`;
    await withTenant(pools.owner, a, (db) =>
      db.query(`insert into api_keys(id, org_id, project_id, name, prefix, hash) values ($1,$2,$3,'k',$4,'\\x00')`, [newId("apiKey"), a.orgId, a.projectId, prefix]),
    );
    const direct = await pools.app.query("select id from api_keys where prefix = $1", [prefix]);
    expect(direct.rowCount).toBe(0);
    const client = await pools.app.connect();
    try {
      await client.query("select set_config('app.auth_lookup', 'on', false)");
      expect((await client.query("select id from api_keys where prefix = $1", [prefix])).rowCount).toBe(0);
    } finally {
      await client.query("reset all");
      client.release();
    }
    const viaFn = await pools.app.query("select org_id from relayon_auth_lookup_api_key($1)", [prefix]);
    expect(viaFn.rows).toEqual([{ org_id: a.orgId }]);
  });
});
