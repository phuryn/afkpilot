-- A pool of cloud environments that are already built.
--
-- WHY THIS EXISTS. Provisioning a sprite is instant; making it useful is not.
-- A stock sprite is a CLI box with no display server, no Chromium libraries and
-- no app, and installing all of that took 25 minutes end to end (measured
-- 2026-08-27: apt 58s, clone 77s, npm ci 20m, compile 4.6m). Nobody waits that
-- to open a thing they just clicked.
--
-- The install does not get cheaper by being moved. It gets INVISIBLE. Sprites
-- are built ahead of demand and parked; the first open takes one off the shelf
-- and only has to hand it a device token. A user waits the full build only if
-- the shelf is empty, which is the one case where there was nothing to hand
-- them anyway.
--
-- Parked sprites are close to free. Fly's own pricing example bills 10 GB of
-- cold storage for four hours at $0.00; a sprite nobody has woken is cold
-- storage and nothing else. The cost of a pool is the cost of the builds, which
-- would have happened regardless — just later, in front of somebody.
--
-- STILL PAYLOAD-FREE. A row is a machine name and a state. No user is
-- associated with a pool sprite: that is the point, it belongs to nobody until
-- it is claimed, at which moment it leaves this table for `environments`.
create table if not exists public.environment_pool (
  -- The provider-side name, which is also the identity. Unlike `environments`,
  -- there is no device to hang this off — the whole point is that no device
  -- exists yet.
  external_id  text primary key,
  provider     text not null default 'sprite',
  -- building -> ready -> claimed, or -> failed.
  --
  -- `ready` is written by the SPRITE, not by us. Exec over HTTP returns no
  -- output and no exit code (verified: a command writing to stdout and exiting
  -- 7 came back as two bytes), so the relay cannot watch a build from outside.
  -- The machine says when it is done, over the same outbound direction
  -- everything else here uses.
  state        text not null default 'building'
                 check (state in ('building', 'ready', 'claimed', 'failed')),
  -- Proves a readiness report came from the sprite we built, not from someone
  -- who guessed a name. Scoped to this row and useless once the row leaves
  -- `building`; not a durable credential.
  claim_secret text not null,
  -- Why a build failed, for the operator reading the table. Never a payload.
  note         text,
  created_at   timestamptz not null default now(),
  ready_at     timestamptz,
  claimed_at   timestamptz
);

alter table public.environment_pool enable row level security;

-- The filler asks one question: how many are ready or on their way?
create index if not exists environment_pool_state_idx
  on public.environment_pool (state);

-- The oldest ready sprite is the one to hand out, so a build that has been
-- parked longest gets used rather than aging forever.
create index if not exists environment_pool_ready_idx
  on public.environment_pool (ready_at)
  where state = 'ready';

-- Claiming, atomically.
--
-- THE ONE THING THIS TABLE MUST NEVER GET WRONG is handing the same machine to
-- two people. Two tabs, two users, one row: whoever loses must be told the pool
-- was empty and fall back to building, not be given somebody else's
-- environment along with whatever ends up on it.
--
-- FOR UPDATE SKIP LOCKED is what makes that true rather than likely. The row is
-- locked and the state change happens in the same statement, so a concurrent
-- caller cannot read `ready` between another caller's read and write — it skips
-- the locked row and takes the next one, or gets nothing.
--
-- SECURITY DEFINER because RLS on this table is deny-all: only the relay's
-- secret key reaches it, and this function is the only sanctioned way in.
create or replace function public.claim_pool_sprite()
returns table (external_id text, provider text)
language sql
security definer
set search_path = public
as $$
  update public.environment_pool p
     set state = 'claimed',
         claimed_at = now()
   where p.external_id = (
           select c.external_id
             from public.environment_pool c
            where c.state = 'ready'
            order by c.ready_at nulls last
            for update skip locked
            limit 1
         )
  returning p.external_id, p.provider;
$$;

revoke all on function public.claim_pool_sprite() from public;
revoke all on function public.claim_pool_sprite() from anon;
revoke all on function public.claim_pool_sprite() from authenticated;
