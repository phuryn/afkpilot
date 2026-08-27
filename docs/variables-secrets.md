# Variables and secrets

The default relay is keyless. If no Clerk or Supabase variables are set, `npm start` uses `MockSessionVerifier`, an in-memory device registry, and an in-memory usage store. Contributors need no external accounts for ordinary local development.

The relay loads `.env` at startup. That file is gitignored. Copy names from `.env.example` when external-service coverage is needed, supply your own values, and never commit the result.

## Relay runtime

| Variable | Shape and purpose | Default | Where to obtain or choose it |
| --- | --- | --- | --- |
| `RELAY_HOST` | Listen address or hostname. | `127.0.0.1` | Choose locally; use an all-interface address only in a container or environment that provides the intended network boundary. |
| `RELAY_PORT` | Integer TCP port. Takes precedence over `PORT`. | `8787` | Choose an unused local port. |
| `PORT` | Integer platform-provided TCP port. | `8787` when neither port variable is set. | Supplied by the hosting platform; normally omit locally. |
| `CLERK_SECRET_KEY` | Clerk backend secret used to verify session tokens. Setting it selects real verification. | Unset; mock verifier. | Clerk project API keys. |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key exposed by `/api/config` so browser pages can initialize ClerkJS. | Unset; mock browser pages. | The same Clerk project as the secret key. |
| `CLERK_ISSUER` | Exact issuer URL expected after token verification. | Unset; no extra issuer pin. | The issuer configured for the Clerk instance. |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated allowed `azp` origin strings. Empty or `*` disables this post-verification check; a token with no `azp` remains valid. | Unset. | Choose from the public origins that host the browser client. |
| `SUPABASE_URL` | HTTPS Supabase project URL. Must be paired with `SUPABASE_SECRET_KEY`. | Unset; in-memory stores. | Supabase project API settings. |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to browser code. Must be paired with `SUPABASE_URL`. | Unset; in-memory stores. | Supabase project API settings. |
| `DEVICE_KEYS_PEPPER` | High-entropy server secret used as the HMAC key for device-token verification. Required when the Supabase pair is set. | No default. | Generate and store it in the deployment's secret manager; use a non-production development value only for local persistent-store tests. |
| `RELAY_REQUIRED_FEATURE` | Clerk feature identifier required at `/client`. An empty value leaves the entitlement gate open. | Unset. | Choose from the user-scoped features configured in the Clerk instance. |
| `RELAY_FREE_DEVICES` | Non-negative integer fallback device limit used when a required feature is configured. `0` disables this fallback. | `1` | Repository/deployment policy. |
| `RELAY_FREE_WEEKLY_MSGS` | Non-negative integer fallback aggregate message limit used when a required feature is configured. `0` disables this fallback. | `100` | Repository/deployment policy. |
| `RELAY_MAX_MSGS_PER_MINUTE` | Non-negative integer per-user message rate. `0` disables the rate limiter. | `20` | Repository/deployment policy. |
| `SPRITES_TOKEN` | Sprites API token. **Presence is the switch for cloud environments**: without it the relay serves no hosted machines, every device is an ordinary laptop, and `/api/environment/wake-at` answers 404. A secret — it can wake and address every environment in the org. | *(unset)* | Deployment secret. |
| `SPRITES_API_BASE` | Sprites control-plane base URL. Waking calls `POST /v1/sprites/{name}/exec` here — deliberately NOT the sprite public URL, which answers 302 from an auth edge without reaching the machine. Override only for a staging or self-hosted control plane. | `https://api.sprites.dev` | Deployment config. |
| `SPRITES_LABELS` | Comma-separated labels applied to every sprite the relay creates. Trimmed, empties and duplicates dropped, order preserved; when the list is empty the field is omitted from the create call rather than sent empty. Labels are the only way a sprite is attributable later — the name is a one-way hash of the user id, deliberately — so an unlabelled sprite stays unattributable, and labels cannot be added after creation without a second call. | *(unset)* | Deployment config, e.g. `afkpilot,env:dev`. |
| `RELAY_CLOUD_FEATURE` | Clerk feature identifier required to OPEN a cloud environment. Unset means ungated: every account, free included, can provision one — which is the launch position. Setting it does not hide the row; the row stays visible and shows an upgrade instead, because a machine that only appears once you have paid is a product nobody discovers. | Unset (ungated). | Set once the pricing plan carrying the feature exists. |
| `GITHUB_TOKEN` | Optional GitHub token used by desktop download and update-feed resolution. | Unset; unauthenticated public API requests. | A fine-grained token with read access to the public release repository, when higher API reliability is needed. |
| `RAILWAY_GIT_COMMIT_SHA` | Deployment commit identifier used as an asset cache-buster; the server publishes only a short prefix. | Unset. | Injected by Railway. |
| `GIT_COMMIT_SHA` | Generic fallback deployment commit identifier for the same cache-buster. | Unset; content-derived asset hash. | Injected by another build/deployment system. |

`SUPABASE_URL` and `SUPABASE_SECRET_KEY` are an all-or-nothing pair. A partial pair is a startup error. When the pair is complete, `DEVICE_KEYS_PEPPER` is also mandatory. This avoids silently switching a configured deployment to volatile state.

The Docker image sets `NODE_ENV=production`, but relay source does not use it to select authentication or persistence; the variables above do.

## Authenticated canary

`npm run smoke:auth -- <url>` can obtain a real session in one of two ways. Pass an explicit deployment URL; do not rely on a script default.

| Variable | Shape and purpose | Where to obtain it |
| --- | --- | --- |
| `CANARY_CLERK_SECRET_KEY` | Clerk backend secret for minting a test user's session token. | Maintainer-controlled Clerk test instance. |
| `CANARY_USER_ID` | Clerk user ID paired with the canary secret. | The designated test user in that instance. |
| `CANARY_EMAIL` | Email address for a native Frontend API password or email-code sign-in. | A designated non-personal test account. |
| `CANARY_PASSWORD` | Optional password for that test account. | The test-account secret store. |
| `CANARY_EMAIL_CODE` | Optional one-time email-factor or device-trust code requested by the native sign-in flow. | The test inbox or Clerk test-mode mechanism. |
| `CANARY_FAPI_HOST` | Bare Clerk Frontend API hostname: no scheme, path, port, or credentials. | Clerk instance configuration; the script can also derive it from `CLERK_PUBLISHABLE_KEY`. |
| `CLERK_PUBLISHABLE_KEY` | Publishable key used only for the Frontend API host derivation fallback. | The same Clerk test instance. |

Use either the backend pair or a Frontend API email flow; the latter may use a password or an email code. A mock target needs no canary credential. Do not place canary credentials in repository files, shell history, logs, screenshots, or CI artifacts.

## Local browser-test controls

These optional variables adjust local harnesses; they are not relay production configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Playwright's bundled Chromium | Use a specific Chromium executable for touch, legacy, tab-identity, screenshot, and download checks. |
| `E2E_ARTIFACT_DIR` | `e2e-artifacts` | Browser E2E screenshots and relay log directory. |
| `TOUCH_CHECK_PORT` | `8791` | Local touch-check server port. |
| `LEGACY_CHECK_PORT` | `8792` | Local legacy-host server port. |
| `DOWNLOADS_CHECK_PORT` | `8793` | Local desktop-download check server port. |
| `TAB_IDENTITY_CHECK_PORT` | `8794` | Local tab-identity check server port. |
| `SCREENS_PORT` | `8799` | Local screenshot-check server port. |
| `SCREENS_DIR` | `.screens` | Screenshot-check output directory. |

## Committed identity constants

The extension's `src/remote-frames.ts` commits `REMOTE_RELAY_URL = "wss://afkpilot.com"`. Published extension and desktop builds use this public identity and expose no user-facing endpoint setting. `GROK_RELAY_URL` is an extension-side environment override for source development only and is ignored in production host modes.

The wire contract also commits `REMOTE_PROTO_VERSION` in both repositories. It is a compatibility constant, not a secret or deployment selector; see [repositories](repositories.md#mirrored-wire-contract).

Credential flow and the device-token shape are documented in [authentication](authentication.md).
