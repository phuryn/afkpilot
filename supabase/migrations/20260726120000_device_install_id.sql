-- Device identity: the machine, not the row.
--
-- Linking has always been per-row — every link mints a new device — so
-- re-linking a machine that is ALREADY linked (after a reinstall, a relay-URL
-- change, a failed connection) created a SECOND row and tripped the free
-- tier's 1-device cap. A returning user got a paywall for hardware they
-- already owned, which is a conversion bug, not just an annoyance.
--
-- `name` cannot carry identity: it is a hostname label, and one account in the
-- dev database holds five rows all called "DESKTOP-RHFLCK3 (Windows 11)".
-- install_id is the extension's anonymous per-install GUID (its existing
-- INSTALL_ID_KEY, which survives updates), so the relay can recognise a
-- re-link and supersede the old row instead of adding one.
--
-- Nullable on purpose: devices linked before this column existed keep working
-- and simply never dedupe — they fall back to today's behaviour. No content,
-- no per-message metadata; an opaque identifier only (payloads-ephemeral rule
-- untouched).
alter table public.devices add column if not exists install_id text;

-- Dedupe lookup. Partial on live rows so revoked history never blocks a
-- re-link — that history is exactly what piled up while this was broken.
-- Deliberately NOT unique: the relay revokes-then-issues, and a race should
-- leave a stray row for the next link to clean up rather than fail a user's
-- pairing outright.
create index if not exists devices_user_install_idx
  on public.devices (user_id, install_id) where revoked_at is null;
