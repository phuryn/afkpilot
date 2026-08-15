# CLAUDE.md — afkpilot

Relay server + web client for **AFK Pilot** (afkpilot.com) — remote control of
the [grok-build-vscode](https://github.com/phuryn/grok-build-vscode)
extension from a phone or browser. The extension dials OUT to the relay over
WebSocket; browsers connect to the same relay; the relay ferries the
extension's existing host↔webview protocol between them.

Start with [README.md](README.md), then [docs/](docs/) —
[docs/architecture.md](docs/architecture.md) is the hub.

## The two halves

| Repo | Role |
|---|---|
| **this repo** | The relay (`src/server.ts` + pure `link-store`/`devices`/`hub`/`frames`), the web client (`web/` — device picker, link-approval page, chat client), the engineering documentation for both repos |
| [grok-build-vscode](https://github.com/phuryn/grok-build-vscode) | The extension (VS Code/Cursor + desktop app). Ships the thin remote client: `src/remote-frames.ts` (wire mirror + hardcoded relay URL), `src/remote-policy.ts` (message gate), `src/remote-uplink.ts`, `src/keep-awake.ts` |

The wire contract is mirrored: `src/frames.ts` here ↔ `src/remote-frames.ts`
there. Bump `REMOTE_PROTO_VERSION` in **both** on any incompatible change —
but prefer never needing to: protocol changes are **additive**, and clients
gate new affordances on capability detection (did the frame that feeds it
arrive?), never on version numbers.

## Invariants — read before changing anything

- **The relay is policy-free by design.** Capability gating (which messages a
  remote may send) lives in the extension's `remote-policy.ts`, so a
  compromised relay still can't drive host-local actions.
- **Payloads are ephemeral.** The relay NEVER persists prompts, code, images,
  or per-message metadata — not in memory beyond routing, not in the
  database. Never add tables or columns that would. (The one sanctioned
  aggregate is `usage_counters`: a single count per user per week window.)
- **`web/vendor/` is generated** by `npm run sync-ui` from a sibling
  `../grok-build-vscode` checkout, and committed so deploys build from a bare
  clone. Never hand-edit it; rerun sync-ui and commit the diff.
- **Schema changes are a NEW timestamped file in `supabase/migrations/`** —
  the only path; never edit an applied migration, never apply SQL by hand.
  RLS on with zero policies (deny-all) is the standing pattern: only the
  relay's secret key touches the db.
- **Old extensions must keep working.** The relay serves the web client, so
  the client is always as new as the deploy while the extension is whatever
  the user installed. `npm run e2e:legacy` is the executable form of that
  contract. The converse is a release-order invariant: an extension build
  that depends on a new relay frame ships only after the relay carrying it is
  in production.
- `src/` splits pure core / impure edge: `server.ts` and `main.ts` are the
  only I/O seams; everything else is pure and unit-tested.

## Build + test

```bash
npm install
npm run sync-ui     # refresh web/vendor/ (only when the extension UI changed)
npm test            # pure units + a real-WebSocket e2e
npm run e2e:touch   # phone-emulated /chat — touch affordances
npm run e2e:legacy  # /chat against a v2.0.4-only host — the compatibility contract
npm run e2e:screens # real Chromium, two viewports, screenshot gates
npm run e2e:downloads # /desktop with the GitHub Releases API stubbed
npm run gate        # ALL of the above — this repo has no CI; run it before release
npm start           # http://127.0.0.1:8787 (RELAY_HOST / RELAY_PORT env)
```

**Keyless dev is the contributor path:** with no Clerk/Supabase env set, the
relay runs a mock session verifier (any/absent token = the mock user) and an
in-memory device registry — no accounts needed. See
[docs/variables-secrets.md](docs/variables-secrets.md) for every env var and
[docs/test.md](docs/test.md) for when each suite applies.

## Conventions

- Before any commit: `git status --short` AND
  `git ls-files --others --exclude-standard` — read the untracked list, never
  `git add -A` blind. Machine-specific files get `.gitignore`d in the same
  commit.
- `web/vendor/` must match its source — compare against the extension's
  `media/`, don't eyeball it.
- `docs/internal/` is the maintainers' private working area (gitignored);
  public docs must read complete without it and never reference it.
- The hosted service deploys from `main` (staging) and the promote-only
  `production` branch; deployment specifics live in
  [docs/CICD.md](docs/CICD.md).
