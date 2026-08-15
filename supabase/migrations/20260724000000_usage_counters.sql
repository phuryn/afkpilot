-- Persistent free-tier usage — one aggregate row per user + window. The
-- window is anchored to Tuesday 17:00 Europe/Warsaw; the relay computes the
-- DST-aware timestamptz key, so summer and winter both reset at 17:00 local.
-- No cron: touching a user's current window lazily drops their older rows.
--
-- Message payloads and per-message rows are NEVER stored. Only the relay
-- (secret key) touches this table: RLS is enabled with NO policies = deny-all
-- for publishable/anon/authenticated clients.
create table if not exists public.usage_counters (
  user_id      text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, window_start)
);

alter table public.usage_counters enable row level security;

-- Atomic increment avoids a read-then-write race when a user has multiple
-- browser sessions. SECURITY INVOKER is intentional: only service_role can
-- pass the table's deny-all RLS.
create or replace function public.increment_usage(
  p_user_id text,
  p_window_start timestamptz
)
returns integer
language plpgsql
security invoker
as $$
declare
  new_count integer;
begin
  delete from public.usage_counters
    where user_id = p_user_id
      and window_start < p_window_start;

  insert into public.usage_counters (user_id, window_start, count)
    values (p_user_id, p_window_start, 1)
    on conflict (user_id, window_start)
    do update set count = usage_counters.count + 1
    returning count into new_count;

  return new_count;
end;
$$;

revoke all on function public.increment_usage(text, timestamptz) from public;
grant execute on function public.increment_usage(text, timestamptz) to service_role;
