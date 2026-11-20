-- Relayon main DB, spec §4. Credentials/keys live in the separate vault DB (packages/vault-db).
-- Runs as the owner role. The application connects as a member of relayon_app_role, which is
-- NOT the owner and has NO BYPASSRLS, so FORCE ROW LEVEL SECURITY applies (§11.5).

create extension if not exists citext;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'relayon_app_role') then
    create role relayon_app_role nologin nosuperuser nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'relayon_executor_ro_role') then
    create role relayon_executor_ro_role nologin nosuperuser nobypassrls;
  end if;
end $$;

-- ===== Tenancy & identity =====
create table orgs (
  id text primary key,
  name text not null,
  plan text not null default 'free',
  stripe_customer_id text,
  data_region text not null default 'us',
  created_at timestamptz not null default now()
);

create table users (
  id text primary key,
  email citext unique not null,
  name text,
  created_at timestamptz not null default now()
);

create table org_members (
  org_id text references orgs(id) on delete cascade,
  user_id text references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','developer','approver','viewer')),
  primary key (org_id, user_id)
);

create table projects (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  name text not null,
  environment text not null default 'production',
  default_hold_seconds int not null default 0,
  fail_mode text not null default 'closed' check (fail_mode in ('closed','open')),
  ledger_retention_days int not null default 30,
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create table api_keys (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  prefix text not null,
  hash bytea not null,
  scopes text[] not null default '{actions:write,actions:read}',
  agent_name text,
  allowed_apps text[], allowed_tools text[],
  max_kind text check (max_kind in ('read','create','update','delete','send','pay')),
  allowed_end_users text[],
  allowed_ips cidr[],
  last_used_ip inet,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by text references users(id),
  created_at timestamptz not null default now()
);
create unique index api_keys_prefix_idx on api_keys(prefix);

create table end_users (
  id text primary key,
  org_id text not null, project_id text not null references projects(id) on delete cascade,
  external_id text not null,
  display_name text, email citext,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (project_id, external_id)
);

-- ===== Connections (metadata only; ciphertext is in the vault DB) =====
create table connections (
  id text primary key,
  org_id text not null, project_id text not null references projects(id) on delete cascade,
  end_user_id text references end_users(id) on delete cascade,
  app text not null,
  auth_type text not null check (auth_type in ('oauth2','api_key','bearer','github_app','none')),
  status text not null default 'pending' check (status in ('pending','active','expired','revoked','error')),
  scopes text[] not null default '{}',
  account_label text,
  purpose text not null default 'agent' check (purpose in ('agent','undo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== Tools catalog (global, not tenant data) =====
create table tools (
  id text primary key,
  app text not null,
  source text not null check (source in ('native','upstream_mcp','composio','treg')),
  upstream_id text,
  name text not null,
  title text, description text not null,
  kind text not null check (kind in ('read','create','update','delete','send','pay','other')),
  reversibility text not null check (reversibility in ('read_only','reversible','compensatable','irreversible','unknown')),
  input_schema jsonb not null,
  output_schema jsonb,
  native_mapping text,
  version text not null default '1',
  health jsonb not null default '{}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ===== Runs, actions (ledger) =====
create table runs (
  id text primary key,
  org_id text not null, project_id text not null,
  external_id text,
  agent_name text, end_user_id text,
  status text not null default 'open' check (status in ('open','closed','undoing','undone','partially_undone')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  total_cost_usd_micros bigint not null default 0,
  metadata jsonb not null default '{}'
);
create unique index runs_project_external_idx on runs(project_id, external_id) where external_id is not null;

create table actions (
  id text primary key,
  org_id text not null, project_id text not null,
  run_id text references runs(id),
  parent_action_id text references actions(id),
  end_user_id text, connection_id text,
  tool_id text not null,
  source text not null,
  caller text not null,
  agent_name text, model text,
  input jsonb not null,
  input_hash bytea not null,
  idempotency_key text,
  kind text not null,
  reversibility text not null,
  policy_decision text not null check (policy_decision in ('allow','require_approval','hold','block')),
  policy_rule_ids text[] not null default '{}',
  status text not null check (status in (
     'received','previewed','pending_approval','approved','rejected','expired',
     'held','cancelled','executing','succeeded','failed','blocked')),
  preview jsonb,
  result jsonb,
  error jsonb,
  target_ref jsonb,
  snapshot_id text,
  undo_status text not null default 'none' check (undo_status in (
     'none','available','undoing','undone','conflict','failed','not_possible','compensated')),
  cost_usd_micros bigint not null default 0,
  upstream_cost_usd_micros bigint,
  latency_ms int, upstream_latency_ms int,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  seq bigserial,
  prev_hash bytea, entry_hash bytea
);
create index actions_project_created_idx on actions(project_id, created_at desc);
create index actions_run_created_idx on actions(run_id, created_at desc);
create unique index actions_idem_idx on actions(project_id, idempotency_key) where idempotency_key is not null;

create table snapshots (
  id text primary key,
  action_id text not null references actions(id),
  org_id text not null,
  target_ref jsonb not null,
  before_enc bytea,
  after_enc bytea,
  before_etag text, after_etag text,
  storage text not null default 'inline' check (storage in ('inline','object')),
  object_key text,
  size_bytes int,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table undo_ops (
  id text primary key,
  org_id text not null, project_id text not null,
  scope text not null check (scope in ('action','run')),
  action_id text, run_id text,
  requested_by text not null,
  force boolean not null default false,
  status text not null check (status in ('planned','running','succeeded','partial','failed','conflict')),
  plan jsonb not null,
  report jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ===== Policies, approvals, holds =====
create table policies (
  id text primary key,
  org_id text not null, project_id text not null,
  name text not null,
  version int not null default 1,
  source_format text not null check (source_format in ('yaml','json')),
  source text not null,
  compiled jsonb not null,
  enabled boolean not null default true,
  priority int not null default 100,
  created_by text, created_at timestamptz not null default now()
);

create table approvals (
  id text primary key,
  org_id text not null, project_id text not null,
  action_id text not null references actions(id),
  status text not null check (status in ('pending','approved','rejected','expired','cancelled')),
  required_approvers int not null default 1,
  approver_roles text[] not null default '{approver,admin,owner}',
  decided_by text[], decided_at timestamptz,
  reason text,
  public_token_hash bytea,
  expires_at timestamptz not null,
  channels text[] not null default '{dashboard,webhook}',
  created_at timestamptz not null default now()
);

create table held_actions (
  action_id text primary key references actions(id),
  org_id text not null, project_id text not null,
  execute_at timestamptz not null,
  status text not null check (status in ('waiting','executing','done','cancelled','failed')),
  job_id text,
  cancelled_by text,
  created_at timestamptz not null default now()
);

-- ===== Proxy upstreams =====
create table proxy_upstreams (
  id text primary key,
  org_id text not null, project_id text not null,
  kind text not null check (kind in ('mcp','composio','treg')),
  name text not null,
  url text,
  auth_connection_id text references connections(id),
  default_policy text not null default 'log_only' check (default_policy in ('log_only','hold_writes','approve_writes','block_unknown')),
  tool_overrides jsonb not null default '{}',
  last_synced_at timestamptz,
  status text not null default 'active'
);

-- ===== Usage, billing =====
create table usage_events (
  id bigserial primary key,
  org_id text not null, project_id text not null,
  action_id text,
  meter text not null check (meter in ('protected_action','execution','approval','undo','snapshot_bytes')),
  quantity bigint not null,
  occurred_at timestamptz not null default now(),
  reported_to_stripe_at timestamptz
);
create index usage_events_org_time_idx on usage_events(org_id, occurred_at);

create table usage_daily (
  org_id text, project_id text, day date, meter text, quantity bigint,
  primary key (org_id, project_id, day, meter)
);

create table budgets (
  id text primary key, org_id text not null, project_id text,
  scope text not null check (scope in ('project','run','agent','end_user')),
  scope_value text, period text check (period in ('run','day','month')),
  limit_usd_micros bigint not null, action_on_exceed text not null default 'require_approval'
);

create table security_settings (
  org_id text primary key, require_mfa boolean not null default true,
  sso_enforced boolean not null default false, cmk_key_ref text,
  ip_allowlist cidr[], session_max_hours int not null default 168
);

-- ===== Webhooks & audit =====
create table webhook_endpoints (
  id text primary key, org_id text not null, project_id text not null,
  url text not null,
  secret_ref text not null,            -- reference into the vault DB; the secret itself never lives here
  events text[] not null, enabled boolean not null default true
);

create table webhook_deliveries (
  id text primary key, org_id text not null, endpoint_id text not null, event_type text not null,
  payload jsonb not null, attempt int not null default 0,
  status text not null, next_attempt_at timestamptz, last_response_code int
);

create table audit_events (
  id bigserial primary key,
  org_id text not null, project_id text,
  actor text not null,
  event text not null,
  target text, data jsonb not null default '{}',
  ip inet, user_agent text,
  created_at timestamptz not null default now()
);

create table idempotency_keys (
  org_id text not null, project_id text not null, key text not null,
  request_hash bytea not null, response jsonb, status_code int,
  created_at timestamptz not null default now(),
  primary key (project_id, key)
);

-- ===== Row-Level Security (§11.5) =====
-- Every table with an org_id column gets ENABLE + FORCE and the tenant_isolation policy.
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from information_schema.columns col
                  where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'org_id')
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (org_id = current_setting('app.org_id', true))
      with check (org_id = current_setting('app.org_id', true))$p$, t);
  end loop;
end $$;

-- orgs: keyed by id
alter table orgs enable row level security;
alter table orgs force row level security;
create policy tenant_isolation on orgs
  using (id = current_setting('app.org_id', true))
  with check (id = current_setting('app.org_id', true));

-- users: visible only when they are a member of the current org
alter table users enable row level security;
alter table users force row level security;
create policy tenant_isolation on users
  using (exists (select 1 from org_members m where m.user_id = users.id and m.org_id = current_setting('app.org_id', true)));

-- ===== Ledger is append-only (§2.2): no DELETE for the app; only guarded status fields change =====
create or replace function relayon_actions_guard() returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.org_id <> old.org_id or new.project_id <> old.project_id
     or new.tool_id <> old.tool_id or new.input_hash <> old.input_hash or new.input <> old.input
     or new.created_at <> old.created_at or new.seq <> old.seq
     or new.prev_hash is distinct from old.prev_hash or new.entry_hash is distinct from old.entry_hash then
    raise exception 'actions ledger: immutable column changed';
  end if;
  return new;
end $$;
create trigger actions_guard before update on actions for each row execute function relayon_actions_guard();

-- ===== API key lookup before tenant context exists =====
-- SECURITY DEFINER (runs as the owner). FORCE RLS applies to the owner too, so a dedicated
-- SELECT policy, granted only to the owner role and only while app.auth_lookup is on, lets this
-- one function find a key by its public prefix. The app role cannot use that policy.
do $$ begin
  execute format($p$create policy auth_lookup on api_keys for select to %I
    using (current_setting('app.auth_lookup', true) = 'on')$p$, current_user);
end $$;

create or replace function relayon_auth_lookup_api_key(p_prefix text)
returns table (
  id text, org_id text, project_id text, hash bytea, scopes text[], agent_name text,
  allowed_apps text[], allowed_tools text[], max_kind text, allowed_end_users text[],
  allowed_ips cidr[], expires_at timestamptz, revoked_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('app.auth_lookup', 'on', true);
  return query
    select k.id, k.org_id, k.project_id, k.hash, k.scopes, k.agent_name, k.allowed_apps, k.allowed_tools,
           k.max_kind, k.allowed_end_users, k.allowed_ips, k.expires_at, k.revoked_at
    from api_keys k where k.prefix = p_prefix;
  perform set_config('app.auth_lookup', 'off', true);
end $$;
revoke all on function relayon_auth_lookup_api_key(text) from public;

-- ===== Grants =====
grant usage on schema public to relayon_app_role, relayon_executor_ro_role;
grant select, insert, update on all tables in schema public to relayon_app_role;
grant delete on held_actions, idempotency_keys, end_users, connections, policies, webhook_endpoints, api_keys to relayon_app_role;
revoke update on audit_events, usage_events from relayon_app_role;
grant usage, select on all sequences in schema public to relayon_app_role;
grant execute on function relayon_auth_lookup_api_key(text) to relayon_app_role;
revoke insert, update on tools from relayon_app_role;   -- catalog is seeded by the owner role only
-- The Executor re-checks actions/connections itself, read-only, under the same RLS (§11.2).
grant select on actions, connections, tools, projects to relayon_executor_ro_role;
