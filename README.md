# AFK Pilot

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE) [![Agents](https://img.shields.io/badge/Agents-Grok%20Build%20%C2%B7%20Codex-000000)](https://github.com/phuryn/grok-build-vscode) [![Remote Control](https://img.shields.io/badge/Remote%20Control-afkpilot.com-0E639C)](https://afkpilot.com) [![Companion](https://img.shields.io/badge/Companion-grok--build--vscode-24292E?logo=github&logoColor=white)](https://github.com/phuryn/grok-build-vscode)

**Watch, approve and steer your coding agent from your phone.** AFK Pilot pairs
the [Grok Build for VS Code (Community)](https://github.com/phuryn/grok-build-vscode)
extension with any browser: follow a running turn, approve permissions, answer
questions, and send or steer messages while you are away from your desk.

### Just want to use it?

Everything a user needs ships with the extension, not here:

- **[Install the extension](https://marketplace.visualstudio.com/items?itemName=PawelHuryn.grok-vscode-phuryn)**, then turn on Remote Control from the gear menu.
- **[What it does and how to use it](https://github.com/phuryn/grok-build-vscode#readme)** — features, quick start, Remote Control.
- **[User documentation](https://github.com/phuryn/grok-build-vscode/blob/main/docs/README.md)** — install paths, desktop app, slash commands, voice, privacy.
- **[Grok Build Desktop](https://afkpilot.com/desktop)** — the standalone app, if you would rather not use an editor.
- Sign in and manage your devices at **[afkpilot.com](https://afkpilot.com)**.

### This repository

The engineering half: the relay server and web client behind afkpilot.com, and
the documentation home for **both** repos. The extension dials **out** to this
relay over WebSocket; your phone or browser connects to the same relay; the
relay ferries the extension's existing host↔webview protocol between them.
Nothing is hosted on your laptop and nothing dials into it. Videos are never
transferred to remote clients (images only).

Contributors start with [docs/](docs/README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md); the rest of this README is the architecture
tour.

> **Report issues in the extension repo:** this repo's issue tracker is
> deliberately disabled so everything lands in one place. Bugs and feature
> requests — relay and web-client ones included — go to
> [grok-build-vscode issues](https://github.com/phuryn/grok-build-vscode/issues).

## How it fits together

```
[browser: chat.html = vendored chat.js + WS shim]
        │  ws /client?device=<id>      raw HostMsg / WebviewMsg JSON
        ▼
     [relay]  ── REST /api/link/* (device pairing), /api/devices, pages
        ▲
        │  ws /uplink?token=<device token>   hello / host / host-to / snapshot
[VS Code extension uplink]                   ← client-ready / client-left / msg / clients
```

- **The relay is policy-free.** Capability gating (which messages a remote may
  send: approvals, destructive ops, host-local no-gos) lives in the extension's
  `src/remote-policy.ts` — a compromised relay can inject messages, but the
  extension still refuses host-local ones. Payloads are ferried, never persisted.
- **Repository/session ownership is per browser connection.** The extension
  targets owned conversation state with `host-to`; device-wide `host` frames
  are the broadcast exception. Reconnects receive a fresh `clientId`, so the
  web outbox waits for confirmed repository + session restoration before it
  flushes. Live attachments and microphone audio are never persisted.
- **The web UI is the extension's webview UI**, vendored (not forked): run
  `npm run sync-ui` to copy `chat.js`/`chat.css`/helpers/MathJax/mermaid from a
  sibling `../grok-build-vscode` checkout (or pass a path). `web/chat.html`
  mirrors the extension's `getHtml()` skeleton — update it if that page changes.
- **Wire contract:** `src/frames.ts` here mirrors `src/remote-frames.ts` in the
  extension repo. Bump `REMOTE_PROTO_VERSION` in both on incompatible changes —
  and prefer additive changes gated by capability detection, so old extensions
  keep working (see [docs/repositories.md](docs/repositories.md)).

## Device-link flow (what "Grok: Link Remote Device" does)

1. Extension `POST /api/link/start {name}` → `{code}` (8 chars, unambiguous).
2. Extension opens the browser at `/link?code=…`; the user checks the code and
   clicks **Approve** (behind a Clerk session + entitlement on the hosted
   service; the dev mock accepts anyone).
3. Approval issues a long-lived **device token** bound to that account.
4. Extension polls `POST /api/link/poll {code}` → `{status:"approved", token}`,
   stores the token in VS Code `secrets`, and connects to `/uplink?token=…`.
   A bad/expired token is refused with close code `4001` = "re-link, don't retry".

## Run it locally

```bash
npm install
npm test              # pure units + a real-WebSocket end-to-end
npm start             # http://127.0.0.1:8787  (RELAY_HOST / RELAY_PORT env to change)
```

**No accounts needed for development.** The pages auto-detect the auth mode
via `GET /api/config`. Without `CLERK_SECRET_KEY` the relay runs **mock
session auth**: any — or absent — session token is accepted as the mock user
with every entitlement, the pages skip ClerkJS entirely, and devices live
in-memory. That makes a keyless instance wide open — treat it as dev only:
localhost / trusted network.

To wire real auth and persistence (Clerk + Supabase + entitlements), see
[docs/variables-secrets.md](docs/variables-secrets.md) and
[docs/authentication.md](docs/authentication.md).

Note the extension's relay URL is a **hardcoded constant**
(`REMOTE_RELAY_URL` in its `src/remote-frames.ts`, committed as
`wss://afkpilot.com`) — there is deliberately no user setting. Testing an
extension build against your own relay means editing that constant and
rebuilding; see [docs/grok-build-integration.md](docs/grok-build-integration.md).

## Documentation

[docs/README.md](docs/README.md) is the index. The load-bearing ones:

- [docs/architecture.md](docs/architecture.md) — component map of both repos,
  the pure-core/impure-edge module layout, data-flow diagrams, hosting shape.
- [docs/security.md](docs/security.md) — threat model, the two-credential model
  (Clerk sessions + HMAC device tokens), the enforcement-point table, and the
  no-E2E decision.
- [docs/relay-protocol.md](docs/relay-protocol.md) — wire reference: every REST
  endpoint, both WS edges, all frames, and the close codes.
- [docs/repositories.md](docs/repositories.md) — the two repos, the mirrored
  wire contract, vendoring, and the release-order invariant.
- [docs/test.md](docs/test.md) — every suite in both repos and when each gates.

## Layout

| Path | Role |
|---|---|
| `src/frames.ts` | Wire contract (mirror of the extension's `remote-frames.ts`) + parsers |
| `src/link-store.ts` | Pure device-link state machine (start → approve → poll, TTL'd codes) |
| `src/devices.ts` | Async `DeviceRegistry` interface + the in-memory (mock auth) impl |
| `src/devices-supabase.ts` | Supabase-persisted registry — HMAC-keyed device tokens, tombstone revoke |
| `src/device-keys.ts` | Pure `sk-device-<kid>.<secret>` scheme: issue / parse / HMAC / constant-time compare |
| `src/auth.ts` `src/auth-clerk.ts` | Session claims + entitlement gate (pure) and the Clerk-backed verifier (impure) |
| `supabase/migrations/` `supabase/config.toml` | Postgres schema as CLI-layout migrations (devices; RLS deny-all). Edge functions: none by design |
| `src/hub.ts` | Pure routing: one uplink + N browser clients per device; ready→client-ready→snapshot choreography |
| `src/server.ts` | Impure edge: HTTP (REST + pages + `/vendor/*`) and the two WS endpoints |
| `src/main.ts` | Entry point (crypto-backed deps, env config) |
| `web/` | `index.html` landing + device picker, `link.html` approval page, `chat.html` chat client; `vendor/` synced UI (committed; refresh via `npm run sync-ui`) |
| `web/auth.js` | Shared browser auth: loads ClerkJS from the instance FAPI (or no-ops in mock mode), exposes `grokAuth` (getToken / requireSignIn / hasFeature) |
| `test/` | Unit tests per pure module + `server.integration.test.ts` (real HTTP + real ws end-to-end) |

## Deploy / self-host

The repo ships a two-stage [`Dockerfile`](Dockerfile) (build with `tsc`, run a
slim `--omit=dev` image). The relay needs a WebSocket-capable host; serverless
platforms cannot run it (long-lived sockets + in-memory hub routing).

```bash
docker build -t grok-relay .
docker run -p 8787:8787 --env-file .env grok-relay
```

- **`RELAY_HOST=0.0.0.0`** is baked into the image (the relay must bind all
  interfaces in a container; the local default `127.0.0.1` would be unreachable).
- **Health check:** `GET /api/health` returns `{ok:true}` and probes no
  dependencies (a db/Clerk blip must not make the orchestrator restart the
  relay). The Dockerfile's `HEALTHCHECK` already hits it.
- `web/vendor/` (the synced chat UI) is **committed**, so the image builds
  from a bare clone — no pre-build step.
- The full environment-variable catalog (auth, persistence, entitlements,
  limits, the GitHub token for `/download` + `/update/*`) is in
  [docs/variables-secrets.md](docs/variables-secrets.md); how the hosted
  service ships is in [docs/CICD.md](docs/CICD.md).
- Deploy gate: CI runs `npm run gate:ci` on every push and pull request, but it
  cannot run `e2e:browser` (no Clerk credentials), so `npm run gate` locally is
  still the release gate. Then `npm run smoke <url>` against the deployment;
  `npm run smoke:auth` covers the authenticated link→approve→connect mile when
  canary credentials are configured.

## License

[FSL-1.1-MIT](LICENSE) — same license as the extension: free for any
permitted purpose except offering a competing hosted service; each version
becomes MIT two years after release.

Support / security contact: **support@productcompass.pm**.
