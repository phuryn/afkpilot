-- When a cloud environment first became usable.
--
-- WHY. Between "you clicked open" and "there is a machine on the other end"
-- there can be twenty-five minutes, and for all of it the row looked exactly
-- like a laptop that is switched off. That is the wrong thing to show someone
-- who just asked for a machine to be made: it reads as broken, and the honest
-- answer — "it is being built, this long so far" — was not available because
-- nothing recorded the difference.
--
-- A pool makes that wait rare rather than absent. When the shelf is empty
-- somebody still waits for a real build, and that person is exactly the one who
-- must not be shown "offline".
--
-- NULL means never yet reached. Not "asleep": an environment that has linked
-- once and is now paused has a timestamp here and is simply offline in the
-- ordinary way, which the picker already knows how to say. The distinction is
-- the whole point of the column.
--
-- Written by the RELAY, when the machine's uplink first connects. Not by the
-- sprite reporting in: the relay already observes exactly this event for every
-- device it serves, and an observation beats a claim.
alter table public.environments
  add column if not exists ready_at timestamptz;

-- Rows that predate this column belong to machines that have been linked for a
-- while — backfilling them to their creation time is closer to true than
-- leaving them NULL, which would show every existing environment as "being
-- built" the moment this ships.
update public.environments
   set ready_at = created_at
 where ready_at is null;
