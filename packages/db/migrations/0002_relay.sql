-- Core relay additions.

-- Who requested the action (api key id or user id). Needed for separation of duties (§7.4 step 7).
alter table actions add column principal text;

-- Sweepers (§7.5) run across tenants. Like the API key lookup, they go through narrow SECURITY
-- DEFINER functions that return only ids, using an owner-only policy gated by a transaction flag.
do $$ begin
  execute format($p$create policy sweeper on held_actions for select to %I
    using (current_setting('app.sweeper', true) = 'on')$p$, current_user);
  execute format($p$create policy sweeper on approvals for select to %I
    using (current_setting('app.sweeper', true) = 'on')$p$, current_user);
end $$;

create or replace function relayon_due_holds(p_limit int)
returns table (action_id text, org_id text, project_id text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('app.sweeper', 'on', true);
  return query
    select h.action_id, h.org_id, h.project_id from held_actions h
    where h.status = 'waiting' and h.execute_at <= now()
    order by h.execute_at limit least(p_limit, 500);
  perform set_config('app.sweeper', 'off', true);
end $$;

create or replace function relayon_due_approval_expiries(p_limit int)
returns table (approval_id text, org_id text, project_id text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('app.sweeper', 'on', true);
  return query
    select a.id, a.org_id, a.project_id from approvals a
    where a.status = 'pending' and a.expires_at <= now()
    order by a.expires_at limit least(p_limit, 500);
  perform set_config('app.sweeper', 'off', true);
end $$;

revoke all on function relayon_due_holds(int) from public;
revoke all on function relayon_due_approval_expiries(int) from public;
grant execute on function relayon_due_holds(int), relayon_due_approval_expiries(int) to relayon_app_role;
