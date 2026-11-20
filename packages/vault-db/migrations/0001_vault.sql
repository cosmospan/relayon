-- Relayon VAULT DB (§11.4). Separate instance; reachable only by apps/executor and apps/connect.
-- Holds ciphertext and wrapped DEKs only. Plaintext never touches this database.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'relayon_executor_role') then
    create role relayon_executor_role nologin nosuperuser nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'relayon_connect_role') then
    create role relayon_connect_role nologin nosuperuser nobypassrls;
  end if;
end $$;

-- Wrapped data-encryption keys. Connect creates them via KMS GenerateDataKey (encrypt-only);
-- only the Executor can unwrap them (KMS Decrypt). Encryption context binds each to its org.
create table org_keys (
  id text primary key,                         -- dek_...
  org_id text not null,
  kms_key_arn text not null,                   -- KEK reference
  wrapped_dek bytea not null,
  context jsonb not null,                      -- encryption context used when wrapping
  status text not null default 'active' check (status in ('active','retired','shredded')),
  created_at timestamptz not null default now()
);

create table credentials (
  id text primary key,                         -- cred_...
  connection_id text not null unique,
  org_id text not null,
  access_token_enc bytea,
  refresh_token_enc bytea,
  api_key_enc bytea,
  field_version int not null default 1,
  expires_at timestamptz,
  dek_id text not null references org_keys(id),
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);

create table oauth_clients (
  id text primary key, org_id text not null, app text not null,
  client_id text not null, client_secret_enc bytea not null, dek_id text not null references org_keys(id),
  created_at timestamptz not null default now()
);

create table oauth_states (
  state text primary key, org_id text not null, connection_id text not null, code_verifier_enc bytea,
  dek_id text references org_keys(id),
  redirect_uri text not null, expires_at timestamptz not null
);

create table decrypt_log (
  id bigserial primary key, org_id text not null, connection_id text not null,
  action_id text, purpose text not null check (purpose in ('execute','refresh','undo','revoke')),
  executor_instance text not null, created_at timestamptz not null default now()
);

-- Single-use exec requests (§11.2): one row per action_id+purpose; a replay hits the primary key.
create table exec_nonces (
  nonce text primary key,
  org_id text not null,
  used_at timestamptz not null default now()
);

-- decrypt_log is append-only, even for the owner.
create or replace function relayon_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger decrypt_log_append_only before update or delete on decrypt_log
  for each row execute function relayon_append_only();

-- Defence in depth: tenant RLS in the vault too. Executor/Connect set app.org_id per request.
do $$
declare t text;
begin
  foreach t in array array['org_keys','credentials','oauth_clients','oauth_states','decrypt_log','exec_nonces'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (org_id = current_setting('app.org_id', true))
      with check (org_id = current_setting('app.org_id', true))$p$, t);
  end loop;
end $$;

grant usage on schema public to relayon_executor_role, relayon_connect_role;
grant usage, select on all sequences in schema public to relayon_executor_role;

-- Executor: read ciphertext, rotate tokens on refresh, log decrypts, burn nonces. No delete.
grant select on org_keys, credentials, oauth_clients to relayon_executor_role;
grant update (access_token_enc, refresh_token_enc, expires_at, rotated_at, dek_id) on credentials to relayon_executor_role;
grant insert on decrypt_log, exec_nonces to relayon_executor_role;

-- Connect: write-only for secrets. It can see ids (to upsert) but not ciphertext columns.
grant insert on org_keys, credentials, oauth_clients, oauth_states to relayon_connect_role;
grant select (id, org_id, status) on org_keys to relayon_connect_role;
grant select (id, connection_id, org_id) on credentials to relayon_connect_role;
grant update (access_token_enc, refresh_token_enc, api_key_enc, expires_at, rotated_at, dek_id, field_version) on credentials to relayon_connect_role;
-- Crypto-shred on connection delete (§11.4): connect nulls the ciphertext and marks the DEK shredded.
grant update (status) on org_keys to relayon_connect_role;
