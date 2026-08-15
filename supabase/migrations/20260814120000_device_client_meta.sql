-- Device client metadata: which host linked, and which OS it is on.
--
-- Until now a device stored a single name string such as
-- "DESKTOP-RHFLCK3 (Windows 11)". That cannot say whether the row is a
-- VS Code extension, Cursor, Antigravity, or the desktop app, so the
-- picker cannot label or icon the row accurately. These three nullable
-- columns are the additive fix: new links may send them; older rows
-- stay null and the picker falls back to parsing the legacy name.
--
-- Device metadata only — no prompts, code, paths, or per-message data
-- (payloads-ephemeral rule untouched). Nullable on purpose so devices
-- linked before this existed keep working. RLS/deny-all unchanged.
alter table public.devices add column if not exists client_label text;
alter table public.devices add column if not exists platform text;
alter table public.devices add column if not exists os_label text;
