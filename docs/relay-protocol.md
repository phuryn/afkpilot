# Relay protocol reference

Everything a client (extension, future daemon, web, future mobile) needs to
speak to the relay. Source of truth: `src/server.ts` + `src/frames.ts` here,
mirrored by `src/remote-frames.ts` in the extension repo.
`REMOTE_PROTO_VERSION = 1` — bump in **both** repos on any incompatible change;
evolution should be additive (new optional fields / new frame types that old
peers ignore), because web/mobile clients and installed extensions update on
different cadences.

## HTTP (REST + pages)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/config` | — | `{publishableKey, requiredFeature}` (either may be `null`). **Open** — the pages need it before any session exists; `publishableKey:null` = mock mode (pages skip ClerkJS entirely) |
| POST | `/api/link/start` | `{name}` (device display name), optional `{installId}`, optional `{clientLabel, platform, osLabel}` | `{code}` — 8 chars, unambiguous alphabet `A-HJ-NP-Z2-9`, 10-min TTL. 400 `{ok:false, error:"install-id"}` when `installId` carries an unrecognised discriminator (see below). 400 `{ok:false, error:"client"}` when a client field is present but invalid (label >64 chars or non-printable; `platform` not `win`/`mac`/`linux`/`unknown`). Absent client fields stay null — never invented. Additive: hosts that send only `name` keep working |
| GET | `/api/link/info?code=` | — | `{status: pending\|approved\|expired\|unknown, deviceName?}` (what the approval page shows). **Open** — pre-sign-in the page still shows the device name |
| POST | `/api/link/approve` | `{code}` | **Session required** (+ entitlement). `{ok:true, deviceId}`, 400 `{ok:false, status}`, 401 `{ok:false, error:"auth"}`, 403 `{ok:false, error:"entitlement"}`. The issued device is scoped to the verified user id; `deviceId` feeds the approval page's "Grok Remotely" button |
| POST | `/api/link/poll` | `{code}` | `{status:"pending"}` \| `{status:"approved", token}` \| `{status:"expired"\|"unknown"}`. Approved keeps answering until TTL (a lost response must not strand the device) |
| GET | `/api/devices` | — | **Session required** (401 `{ok:false, error:"auth"}` otherwise). `{devices:[{deviceId, name, createdAt, online, clients, clientLabel, platform, osLabel}]}` — ALL of the CALLER's devices, offline included (`online` = live uplink, `clients` = connected viewers). `clientLabel` / `platform` / `osLabel` are `null` on rows linked before those fields existed; the picker falls back to parsing a legacy `name` like `HOST (Windows 11)` |
| DELETE | `/api/devices/{id}` | — | **Session required.** Owner-checked revoke: `{ok:true}`; 404 `{ok:false, error:"unknown"}` for unknown OR not-owned (existence not leaked). A live uplink is closed with `4001` (token dead — re-link, don't retry) |
| POST | `/api/device/unlink` | — (`Authorization: Bearer sk-device-…`) | **Device-token auth** (possession = the device; session-free like `/uplink`). Self-revoke: `{ok:true}` (uplink closed `4001`), 401 `{ok:false, error:"token"}`. The extension calls it on "Sign out (unlink this device)" so the row stops counting against the device cap |
| GET | `/api/me` | — | **Session required.** `{userId, entitled, limits}` — `limits` is `null` (entitled, or no free tier) or `{weeklyMsgs, used, devices, maxPerMinute}` (the landing's usage meter) |
| GET | `/update/win/latest.yml` | — | **Open** (no session). Rewritten electron-builder `latest.yml` of the newest non-draft GitHub Release of `phuryn/grok-build-vscode` that carries the Windows NSIS installer (`-win-x64.exe`) and a `latest.yml` listing it. `Content-Type: application/x-yaml`. 404 if no such release; 503 if GitHub is unreachable past the cache TTL (a cached answer is served only while younger than ~10 min — no stale copies). Never HTML-with-200 |
| GET | `/update/mac/latest-mac.yml` | — | **Open.** Same for macOS: the yml must list **both** `-mac-arm64.zip` and `-mac-x64.zip`. A one-arch yml is a failed build and is skipped (older releases are searched for a valid dual-arch yml). 404 / 503 as above |
| GET | `/` `/link` `/chat` | `?code=` / `?device=` | the web pages |
| GET | `/auth.js` | — | the shared browser auth helper (ClerkJS loader; mock-mode no-op) |
| GET | `/device-display.js` | — | picker helper: OS icon + legacy-name fallback for device rows |
| GET | `/vendor/*` | — | synced UI assets (traversal-guarded) |

JSON bodies capped at 1 MiB.

**Desktop update feed (`/update/win/latest.yml`, `/update/mac/latest-mac.yml`).**
Public, unauthenticated GETs — they serve public release metadata only, same
as the site pages. The desktop client's `electron-updater` (generic provider)
hits these instead of GitHub's "latest" because a vsix-only tag would stall
every installed app. Selection is **per channel**, newest-first, drafts
skipped, pre-releases counted. `files[].url` (and a legacy top-level `path`,
if present) are rewritten from the builder's relative artifact name to

`https://github.com/phuryn/grok-build-vscode/releases/download/<tag>/<filename>`

`sha512` / `size` / `version` / `releaseDate` are preserved byte-for-byte;
blockmap entries are never invented (the updater derives `{fileUrl}.blockmap`
from the rewritten installer URL). Rewritten yml is cached in memory for
~10 minutes, positive and negative; there is deliberately NO stale-serve —
past the TTL a failed refresh is a real 503 (with a ~60s backoff so an
outage does not re-walk GitHub per GET), so a yanked yml never outlives one
TTL and clients just fall back to their notice path. The binaries stay on
GitHub — these endpoints never proxy installer bytes.

**`installId` (optional, anonymous, never displayed).** An opaque per-machine id
the client sends when linking. Absent on older builds, which simply never
dedupe. Two uses, and they are deliberately different:

- **Supersede** matches the **full** id exactly. Re-linking the same client on
  the same machine revokes its previous row, so a reinstall or a failed
  connection does not mint a second device and bounce the user off the free
  tier's cap.
- **The free-tier device cap counts MACHINES, not rows**: `<machine>` and
  `<machine>:desktop` share one slot, so a second client on a machine the
  user already linked is free.

Only two shapes are recognised — a bare id (the VS Code extension) and
`<id>:desktop` (the desktop app). Anything else is rejected at ingest with
`400 {ok:false, error:"install-id"}` **and**, independently, counted as its own
machine — the cap invariant does not rely on the ingest check. Trimmed and
truncated to 200 chars *before* validation, so the stored value always satisfies
the checked property. Adding a third client kind is a deliberate relay-side
edit, never something a client can assert. Note the claim is **not
server-verifiable** — the relay trusts the declared kind, and the cap
invariant is designed to hold even for a client that lies about it.

**`clientLabel` / `platform` / `osLabel` (optional, device metadata).** Sent
alongside `name` on `/api/link/start` so the picker can show which host linked
and which OS it is, instead of stuffing that into the name string. `platform`
is `win` | `mac` | `linux` | `unknown`. Labels are trimmed, capped at 64
printable characters, and refused (not coerced) when they fail — `400
{ok:false, error:"client"}`. Absent fields stay null; the relay never invents
them. Older hosts that send only `name` keep working; the picker then falls
back to a trailing `(…)` on the stored name. Do **not** bump
`REMOTE_PROTO_VERSION` — this is additive. New hosts should still send the
legacy `name` form (`HOST (Windows 11)`) so an older relay remains readable.

## Auth

- **Session token** — a Clerk session JWT (v2). Sent as `Authorization: Bearer
  <token>` on REST calls, or the `__session` cookie (which is all a browser
  WebSocket upgrade can carry) on the `/client` upgrade. `SessionVerifier`
  verifies it networklessly; dev runs a **mock** verifier (any — or, in the
  permissive dev mode, an absent — token = the mock user). Guards
  `/api/link/approve`, `/api/devices`, and the `/client` upgrade. `/api/link/*`
  start/info/poll and the `/uplink` upgrade take no session.
- **Device token** — the opaque `sk-device-<kid>.<secret>` issued at approval,
  the sole credential on `/uplink`. The db keeps only kid + an HMAC of the
  secret (see `supabase/migrations/`); it never leaves VS Code secrets otherwise.
- **Entitlement** — a Clerk Billing feature slug (`RELAY_REQUIRED_FEATURE`).
  Unset = open gate. Checked on `/api/link/approve` (403) and the `/client`
  upgrade (close 4005). **Enforcement lives at `/client`**, not `/uplink`: the
  extension dialing out is an unauthenticated-user connection by design (device
  token only), and blocking the browser side is what gates the paid feature.

## WebSocket endpoints

**Heartbeat (both edges):** the relay sends a protocol-level ping every 30s
(`pingIntervalMs`, 0 disables) — proxies kill idle WebSockets (Cloudflare:
~100s without traffic) and the uplink is idle whenever nobody chats. Peers
need no code: ws clients and browsers auto-pong. A socket that misses a pong
for a full interval is terminated (reaps half-dead uplinks that would
otherwise block reconnects with 4002).

### `/uplink?token=<device token>` — the extension/daemon (one per device)

Close codes (keep in sync with `remote-uplink.ts` in the extension, which
treats 4001 as "re-link, don't retry"):

| Code | Meaning |
|---|---|
| 4001 | bad/expired device token — client must run the link flow again |
| 4002 | device already has a live uplink (second VS Code window, same token) |
| 4006 | protocol refusal — the peer omitted `hello` before host traffic, or its protocol is newer than the relay understands; inspect the close reason and update the relay before retrying a newer peer |
| 1011 | registry/db error verifying the token — retry, do NOT re-link |

Frames **extension → relay** (`UplinkFrame`):

| Frame | Shape | Purpose |
|---|---|---|
| hello | `{t:"hello", proto, device?:{name}, client?:{clientLabel, platform, osLabel}}` | required once on open, before any `host`/`host-to`/`snapshot` traffic. Optional `client` uses the same validation as `/api/link/start` (labels ≤64 printable chars; `platform` is `win`/`mac`/`linux`/`unknown`). When those fields differ from the stored row, the relay updates `client_label`/`platform`/`os_label` only (never `name`/`user_id`). Absent or empty `client` is a no-op so older extensions keep working. Additive — do not bump `REMOTE_PROTO_VERSION` |
| host | `{t:"host", msg:<HostMsg>}` | device-wide state only: broadcast to every browser client of this device |
| host-to | `{t:"host-to", clientIds:[...], msg:<HostMsg>}` | session/view state for exactly the listed browser clients; unknown/departed ids are ignored |
| snapshot | `{t:"snapshot", clientId, msgs:[<HostMsg>...]}` | ordered catch-up for ONE client (answering client-ready) |

Frames **relay → extension** (`RelayFrame`):

| Frame | Shape | Purpose |
|---|---|---|
| client-ready | `{t:"client-ready", clientId, tabToken?:string}` | a browser sent `ready`; the optional logical-tab token is preserved, and the extension answers with a snapshot frame for that clientId. One token is one client: if another connected client already holds that exact token, the hub evicts it first so this frame is preceded by that predecessor's `client-left` |
| client-left | `{t:"client-left", clientId}` | that browser socket departed; release its per-client repo/session ownership and live resources (including voice). Also sent when a later client presents the same tab token (the predecessor is closed after this frame is written) |
| msg | `{t:"msg", clientId, msg:<WebviewMsg>}` | a browser's message; the client applies its policy gate before acting |
| clients | `{t:"clients", count}` | viewer count (sent on attach and as clients come/go) |

### `/client?device=<deviceId>` — browsers (N per device)

Session-authenticated (Bearer or `__session` cookie) and ownership-checked.
Close codes:

| Code | Meaning |
|---|---|
| 4003 | missing device id, OR the device is unknown / not owned by this session (not leaked which) |
| 4004 | no verified session on the upgrade |
| 4005 | session verified but missing the required entitlement |
| 1011 | session/registry error while verifying — retry |

The device must exist AND belong to the session user before any client attaches
(no more auto-creating hub entries for unknown ids). Browsers then speak the
**raw webview protocol** (HostMsg / WebviewMsg JSON, no frames — the Phase-0
shim unchanged):

- browser sends `{type:"ready", tabToken?:string}` → relay converts to
  `client-ready`, preserving a string token when present (never forwarded
  as-is).
- browser sends `{type:"transportProbe"}` → the relay answers the same
  browser with `{type:"transportProbe"}` and never forwards it. Answered
  at ingress, not serialized behind other client frames (a metered send
  waiting on the usage store must not starve the liveness reply). This is
  transport liveness of the browser↔relay socket (including with no
  uplink), not a host-protocol type — do not bump `REMOTE_PROTO_VERSION`.
- every other browser message wraps into a `msg` frame for the uplink.
- relay unwraps `host`/`host-to`/`snapshot` frames and delivers plain HostMsg
  JSON. `host` is device-wide; `host-to` and `snapshot` preserve per-client
  ownership.
- no uplink connected (or the uplink is not deliverable — `readyState` other than OPEN) → relay injects `{type:"error", text:"Device offline — VS Code isn't connected to the relay."}`, plus `submissionId` when the refused frame carried one, so the browser can hold that send and no other (rendered by chat.js's normal error path).

Every browser socket receives a fresh, opaque `clientId`, including after a
reconnect. The extension owns the mapping from that id to the tab's selected
repository and active conversation. The web client therefore sends `ready`
first, consumes the snapshot, and re-asserts its sessionStorage-backed
`selectRepo`/`resumeSession`. Its persisted ordinary-message outbox remains
held until host `repos` and `sessions` frames confirm the remembered repository
and active session for the new connection. The 15-second restoration watchdog
is only a progress notice: it does not discard the queue or relax the identity
guard. Queued ordinary messages persist in this tab's `sessionStorage` until
identity is confirmed and they can safely flush, or until the user explicitly
changes repository or conversation. An explicit identity change rejects the
old queued work instead of executing it in a different workspace or session.

`pasteImage`, `uploadFile`, and the whole live microphone family
(`remoteVoiceStart`/`remoteVoiceChunk`/`remoteVoiceStop`) are never put in the
persisted outbox. A disconnect cancels browser recording and returns the mic UI
to idle; audio is not replayable deferred work.

## Choreography (the whole flow)

```
link:    ext ─POST start→ code ─browser approves→ token ─poll→ ext stores in secrets
connect: ext ─ws /uplink?token→ hello        browser ─ws /client?device→ ready
sync:    relay→ext client-ready → ext→relay snapshot(clientId) → relay→browser msgs
restore: browser selectRepo/resumeSession → ext owns that clientId → host-to confirmations
live:    ext host (device-wide) / host-to (owned clients) ⇄ browser raw msgs
leave:   browser socket closes → relay→ext client-left → ext releases ownership
```

Malformed frames are dropped, never fatal. The relay inspects only `t` /
`type` — payloads are opaque and ephemeral (never persisted).

The relay accepts `hello.proto <= REMOTE_PROTO_VERSION`: protocol evolution is
additive, so an older installed extension must remain compatible with a newer
relay. It closes with `4006` only when the peer advertises a newer protocol than
the relay understands. This makes the unsafe new-extension/old-relay direction
fail explicitly without breaking the supported old-extension/new-relay
direction.
