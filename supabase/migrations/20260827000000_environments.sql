-- Cloud environments — the ONE thing the relay learns about a hosted machine.
--
-- A cloud environment is an ordinary linked device that happens to be a machine
-- we run. It links, routes and obeys policy exactly like a laptop; nothing in
-- `devices`, the hub or the protocol changes. What a laptop does not need, and
-- this does, is a way to be woken: its uplink is outbound-only, so when it
-- sleeps that socket dies and there is nothing left to send anything over. Only
-- the relay knows a client is asking, so only the relay can make the inbound
-- call that wakes it. This table is what makes that possible and nothing more.
--
-- PAYLOADS STAY EPHEMERAL, INCLUDING SCHEDULES.
--
-- `wake_at` is one nullable timestamp, written by the host, meaning "wake me
-- then". The obvious alternative — teaching the relay about routines so it can
-- work out when to wake — would put cron expressions, routine names and
-- eventually prompts in this database. The host already computes its own next
-- due window (see routines.ts in the extension, where catch-up is arithmetic),
-- so it can simply say when. The relay stores a number and never learns why.
-- Same class as `usage_counters`: an aggregate per user, not a record of what
-- anyone said or asked for.
--
-- Only the relay's secret key touches this: RLS enabled with NO policies =
-- deny-all for publishable/anon/authenticated clients, the standing pattern.
create table if not exists public.environments (
  -- One environment per device. The device row remains the identity; this is a
  -- side table so that revoking a device revokes the environment with it.
  device_id   text primary key references public.devices (device_id) on delete cascade,
  user_id     text not null,
  -- Which platform runs it. One value today; the column exists so a second
  -- provider does not require a migration on a live table.
  provider    text not null default 'sprite',
  -- Provider-side identity — a sprite name. Not a URL: URLs are derived and
  -- change, names are how you address the thing.
  external_id text not null,
  -- Next scheduled wake, or NULL for nothing scheduled. NULL is a real value a
  -- host must be able to write: a user who deletes their last routine needs the
  -- standing wake cleared, or the machine starts up nightly for nothing.
  wake_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.environments enable row level security;

-- The scheduled-wake sweep asks one question on a timer: which environments are
-- due? A partial index keeps that read proportional to the number of environments
-- with something scheduled, not to the number that exist.
create index if not exists environments_wake_at_idx
  on public.environments (wake_at)
  where wake_at is not null;

-- Listing a user's environments alongside their devices.
create index if not exists environments_user_id_idx
  on public.environments (user_id);
