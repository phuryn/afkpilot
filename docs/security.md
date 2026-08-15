# Security

The security story for the relay in one place: what the attack surface is, how
the two credentials work, where each request is gated, and the decisions that
bound the blast radius. Frame-level detail is in
[relay-protocol.md](relay-protocol.md); the component map is in
[architecture.md](architecture.md).

## Threat model

The extension is internet-**controllable**, not internet-**reachable**. It opens
one outbound WebSocket to the relay (`/uplink`) and listens on no inbound port —
nothing on the internet can dial the dev box, and there is no NAT hole, no LAN
server, no localhost bridge in the shipping path. An attacker therefore cannot
reach the agent directly; they can only reach it *through* a path that the
extension already trusts. That inverts the usual "reduce the reachable surface"
posture into "protect the three trusted paths."

Remote control is remote code execution on the dev box via the agent: a routed
`send` is an arbitrary prompt to an agent that writes files and runs shell
commands, and `permissionAnswer` / `exitPlanAnswer` approve those writes and
plan executions. So the three paths below are the whole game.

| Risk path | What it is | Mitigations |
|---|---|---|
| **Account / session compromise** | An attacker signs in as the user (phished password, stolen session) and drives a linked device from a browser. | Clerk owns login (MFA available on the account); session JWTs are short-lived (~60s) so a captured token expires fast; `/client` is entitlement- and ownership-gated; server-side device revoke (tombstone) cuts a compromised account's devices without a redeploy; the extension shows a "remote connected" indicator + one-click revoke (extension-side, planned). |
| **Device-token theft** | The long-lived `sk-device-<kid>.<secret>` leaks (stolen from VS Code secrets, a URL log, a shoulder-surf). | The token is the `/uplink` credential only — it lets an attacker impersonate the *extension* (offer to be driven), not drive the agent: the human enforcement point is the browser at `/client`, which needs a session + entitlement + ownership. The db stores only `kid` + `HMAC(pepper, userId+secret)`, so the secret never rests in the database and a db leak yields no usable token. Owner-binding means a leaked row can't be replayed under another user. Tokens are revocable (tombstone) and never travel in a URL once the extension moves to an `Authorization` header (planned). |
| **Relay compromise** | The relay host itself is breached, or a malicious relay is substituted. | The relay is **policy-free** (see below): it can inject/observe messages but cannot drive host-local actions, because the capability gate lives in the extension. Payloads are ephemeral (never persisted) so a breached relay has no historical prompt/code store to exfiltrate. TLS everywhere bounds passive network attackers to the endpoints. E2E encryption would close the "relay sees plaintext" gap and is a possible enterprise differentiator (decision below). |

## Credential model

Two credentials, deliberately different in lifetime and scope.

### (a) Clerk session JWT — the human

- **Short-lived (~60s).** A stolen session token is useful for seconds, not days.
- **Verified networklessly** against Clerk's JWKS (`@clerk/backend`'s
  `verifyToken`) — no per-request round-trip to Clerk, no shared secret with the
  relay beyond the secret key that authorizes the JWKS fetch.
- **Issuer-pinned.** `CLERK_ISSUER` is enforced as a post-verify `iss` check
  (`verifyToken` in this version derives the issuer from the secret key's JWKS
  rather than taking an `issuer` option), pinning tokens to our instance.
- **`azp`-checked when present.** When `CLERK_AUTHORIZED_PARTIES` is set,
  a token carrying an `azp` outside the allowlist — one minted for some other
  origin — is rejected. Absent `azp` passes: Clerk omits the claim whenever no
  Origin was sent — every native (non-browser) sign-in, plus documented
  privacy cases in browsers — so requiring it would reject every legitimately
  signed-in native session. Enforced as a post-verify check in the relay
  (`azpAllowed`), not via the library option, which hard-requires the claim.
  Stated precisely: `azp` is a supplementary origin-binding belt on tokens
  that carry it; signature, expiry, and the issuer pin are the load-bearing
  gates for every token.
- **Carried out of URLs.** `Authorization: Bearer <token>` on REST, and the
  `__session` cookie on the `/client` WebSocket upgrade (a browser WS upgrade
  can carry nothing else) — never a token in a query string, which would land in
  access logs.
- **Entitlement rides the JWT.** Active plans (`pla`) and features (`fea`) are
  claims in the verified token (v1 counts only `u:`/`uo:`-scoped slugs — no
  orgs). The relay stores no subscription state.

### (b) Device token `sk-device-<kid>.<secret>` — the extension

- **Long-lived**, issued once at link approval, stored in VS Code `secrets`.
- **HMAC-verified, secret never stored.** The db keeps `kid` (the lookup key)
  and `hmac = base64url(HMAC-SHA256(pepper, userId+secret))`. The secret exists
  exactly once — in the `issue()` response on its way to VS Code — and never
  touches the database. A db leak exposes no usable credential and nothing
  offline-guessable (the pepper is server-side only).
- **Owner-bound.** Mixing the owner's `userId` into the MAC binds the token to
  its account: `verify` recomputes the MAC with the **row's** `user_id` and the
  **presented** secret, so a leaked row can't be replayed cross-user.
- **Constant-time compare.** Verification uses a length-checked
  `timingSafeEqual`, never an early-returning byte compare.
- **Revocable.** Revoke writes a tombstone (`revoked_at`) — an audit trail, and
  an immediate cutoff without rotating anything else.

## Enforcement points

| Point | Credential | Refusals |
|---|---|---|
| `POST /api/link/approve` | Session (Bearer) | `401` no session; `403` `entitlement` (no feature, free tier off) or `403` `entitlement`/`device-limit` (free tier on, device cap hit). Issued device is scoped to the verified user id. |
| `GET /api/devices` | Session (Bearer) | `401` no session. Lists ALL of the caller's own devices (offline included, with liveness/viewer counts) — never anyone else's. |
| `DELETE /api/devices/{id}` | Session (Bearer) | `401` no session; `404` unknown **or** not owned (existence not leaked). Owner-checked revoke: token tombstoned, a live uplink is closed `4001`. |
| `GET /api/me` | Session (Bearer) | `401` no session. Entitlement + free-tier usage for the caller only. |
| `/client` WS upgrade | Session (`__session` cookie) + ownership | `4004` no verified session; `4005` verified but no entitlement (only when the free tier is off); `4003` device unknown **or** not owned by this session — deliberately not distinguished, so ownership can't be probed; `1011` session/registry error while verifying (transient — retry). Every routed `send` first passes the per-minute burst cap (all users); free tier on: it then spends the weekly quota. Over-limit returns an inline error, the socket stays up. |
| `/uplink` WS upgrade | Device token only | Session-free **by design** — the extension dialing out is an unauthenticated-user connection; the human enforcement point is `/client`. `4001` bad/expired token (re-link, don't retry); `4002` device already has a live uplink; `1011` registry/db error verifying (transient — retry). |

**Close-code discipline for the extension:** `4001` means the token is dead —
stop and run the link flow again. `1011` means a transient relay/db hiccup —
back off and retry with the same token; never re-link on `1011`. `/api/config`,
`/api/link/start|info|poll`, and the `/uplink` upgrade take no session (the
device-code pairing flow keeps all sign-in in the browser).

## The relay is policy-free

Capability gating — which messages a remote may send (approvals, destructive
ops, host-local no-gos like `openFile`/`pickFile`/`voiceStart`) — lives in the
extension's `remote-policy.ts`, a pure, tsc-exhaustive classification of every
protocol message type. A compromised or malicious relay can inject or observe
messages, but it **cannot drive host-local actions**: the extension refuses them
regardless of what the relay sends. The relay inspects only the `t`/`type`
discriminant to route; payloads are opaque.

**Payloads are ephemeral.** Prompts, code, and outputs are ferried and never
persisted — so a breached relay has no message store to exfiltrate. This is also
why the quota/rate counters are **in-memory only** (a restart resets the
week's counts): keeping message metadata out of the database is a hard
constraint, generous to users on purpose.

**Images only.** Video is never transferred to remotes (enforced in the
extension's `inlineMediaForRemote`, kind + mime belt); only base64-inlined
images cross the bridge.

**A remote can enlarge a picture, but cannot name a file** (2026-08-01). Tapping
a thumbnail fetches a larger render, which is a remote-triggered read of a file
on the host — so the request carries an opaque handle the HOST issued, never a
path. Handles are minted only where a thumbnail was actually sent
(`inlineChipPreviewForRemote` / `inlineHistoryImageForRemote`), so the set a
remote can fetch is exactly the set it was already shown, and a path-shaped
request has nothing to bind to. A handle the host does not recognise is answered
with **silence** rather than an error, so probing reveals nothing about what
exists on disk. Bounded to the most recent 300 images per window.

## No end-to-end encryption (decision on record)

v1 is a **trusted-relay** model: application payloads transit in plaintext,
protected by **TLS in transit** (`wss`/`https`, terminated at the edge), not by
app-layer encryption. The relay operator can therefore see code, prompts, and
outputs. Obligations that follow from this decision:

- Payloads stay ephemeral **server-side** (never persisted by the relay) — above.
  One deliberate exception lives on the CLIENT, not on our infrastructure: the
  browser keeps an unsent ordinary message in tab-scoped `sessionStorage` until
  identity is confirmed and it can be delivered, so a dropped connection or a
  reload doesn't destroy what the user typed. It never leaves the device until
  sent, is cleared on delivery, and dies with the tab. Attachments and voice
  audio are explicitly excluded from that queue. This is disclosed in the
  privacy policy; the "never persisted" claim is about our servers, and the
  public wording says so.
- The trust is **disclosed** in the privacy policy and the pairing UI: linking a
  device consents to the relay operator seeing that session's traffic.

E2E encryption (the relay ferrying ciphertext) can return later as an enterprise
differentiator. It is out of scope for v1.

## Abuse limits (app-side)

Three app-side caps, all metering only routed `send` prompts (sync traffic is
free), all in-memory (reset on deploy):

- `RELAY_MAX_MSGS_PER_MINUTE` (default 20) — burst cap per user per calendar
  minute, **applies to every user, paid included**. `0` disables.
- `RELAY_FREE_DEVICES` (default 1) — linked-device cap for
  signed-in-but-unentitled users, checked at `/api/link/approve`.
  `RELAY_FREE_DEVICES=0` disables the free tier entirely (hard `403`/`4005`
  gate). Only active when `RELAY_REQUIRED_FEATURE` is configured.
- `RELAY_FREE_WEEKLY_MSGS` (default 100) — routed `send` messages per
  unentitled user per ISO week (resets Monday 00:00 UTC), checked at
  `/client`. Same activation condition.

Network-level rate limiting (per-IP request floods, connection storms) is **not**
in the app — it is delegated to the **Cloudflare edge** in front of the relay,
to be configured at hosting time.

## Operational practices

- **Repository boundary.** The extension ships only the thin remote client
  (wire mirror, policy gate, uplink, link commands); server-side auth,
  persistence, and enforcement live here. Maintainers' private working notes
  are kept outside both public trees.
- **Environment separation.** Development and production run separate Supabase
  projects and separate Clerk instances with distinct keys; secrets exist only
  in each deployment's environment configuration, never in the repo.
- **RLS deny-all on the devices table.** Row-level security is on with **zero
  policies**, so only the relay's secret key reaches the table — no client-side
  Supabase access path exists.
- **`.env` is never committed** (gitignored); `.env.example` documents every var
  with safe placeholders. `DEVICE_KEYS_PEPPER` is required whenever Supabase is
  configured (the relay refuses to start without it).

## Reporting

Security contact: **support@productcompass.pm**.
