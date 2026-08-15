-- Initial schema — consolidated from the former db/schema.sql (+0002), which
-- the DEV project (tkdisonooonmwvyoagig) already carries, applied manually.
-- PROD: applied automatically by the Supabase GitHub integration on push to
-- the production branch. Idempotent on purpose — safe against a db that
-- already has the state.
--
-- Deliberately devices-only for now: the accounts table arrives with Clerk,
-- entitlements with Stripe. Message payloads are NEVER stored anywhere —
-- the relay is ephemeral by obligation (no-E2E decision), and quota counters
-- stay in-memory by design (no per-message metadata in the db).

-- One row per linked VS Code workspace. Only the relay (secret key) touches
-- this table: RLS is enabled with NO policies = deny-all for the
-- publishable/anon key. The device token `sk-device-<kid>.<secret>` never lands
-- here — we keep kid (lookup) + hmac = base64url(HMAC-SHA256(pepper,
-- user_id||secret)); the secret lives only in VS Code secrets on the linked
-- machine (see src/device-keys.ts).
create table if not exists public.devices (
  device_id  uuid primary key default gen_random_uuid(),
  user_id    text not null,          -- Clerk user id ('mock' until Clerk lands)
  name       text not null,
  kid        text not null unique,   -- device-key id (the token's public half)
  hmac       text not null,          -- base64url HMAC of user_id||secret under the server pepper
  created_at timestamptz not null default now(),
  revoked_at timestamptz             -- tombstone; live devices have null
);

create index if not exists devices_user_idx
  on public.devices (user_id) where revoked_at is null;

alter table public.devices enable row level security;
