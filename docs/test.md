# Testing

The repositories test different boundaries. The relay owns transport, browser compatibility, authentication, and deployment smoke checks. The extension owns provider processes, host APIs, policy, the shared renderer source, VS Code integration, and Electron behavior.

Run focused checks while iterating. Run the applicable repository gate before promotion or release.

## What each harness makes real — and what that leaves invisible

The catalogues below say what each suite *covers*. This says what each one
**fakes**, which is the more useful question: a bug survives exactly where every
harness stubs the same side.

| Harness | Relay | Browser client | Host | Agent CLI |
| --- | --- | --- | --- | --- |
| relay `npm test` | real (in-process) | — | — | — |
| `e2e:touch` / `e2e:screens` | real, keyless | **real Chromium** | *scripted stub* | — |
| `e2e:legacy` / tab-identity | real, keyless | real Chromium | *scripted stub* | — |
| `e2e:browser` | real + real Clerk/Supabase | real Chromium | *scripted stub* | — |
| `e2e:signin` | real, keyless | **real Chromium** | *scripted stub* | — |
| `e2e:lifecycle` | real, keyless | real Chromium | **real desktop app** | fake ACP CLI |
| extension `npm test` | — | happy-dom (no layout) | pure modules | — |
| `test:integration` | — | *stubbed* | **real VS Code host** | fake ACP CLI |
| `test:desktop` / `e2e:screens` | — | real Electron window | real desktop host | fake ACP CLI |
| `test:live` | — | — | compiled modules | **real grok** |
| `smoke:live` | — | real Electron window | real desktop app | **real grok** |

Read the two stub columns. Before `e2e:lifecycle` existed, **every** relay suite
drove a real browser against a *stub host* — instant, always warm, never
refuses, never dies — and **every** extension suite drove a real host against a
*stubbed client* with no outbox, no tab memory and no reconnect. So a defect
needing both real halves was invisible by construction, and one needing a
**restart** was doubly so, because every harness boots once into steady state
and stays there.

That is not hypothetical. The restore race shipped through all of it. And on the
day `e2e:lifecycle` first ran it found two more of the same family, neither
reachable by any other suite:

- a prompt sent while the host was restarting was **silently dropped** by the
  browser client (fixed in `93e2b53`);
- the host **silently abandons a send** when a concurrent `startSession` bumps
  the generation after the `userMessage` echo — the client sees the echo, treats
  it as success, and waits forever.

The practical rule when adding a harness: write down which side it fakes, and
check whether that side is already faked by everything else. If it is, the new
suite mostly re-covers ground. Coverage of *surfaces* is not coverage of
*journeys* — nothing here except `e2e:lifecycle` can kill a process in the
middle of one.

Second-order traps worth knowing, both of which have bitten:

- **happy-dom has no layout engine.** Rects are zero and stylesheets never
  apply, so an icon with no size or a control pushed off-screen satisfies every
  assertion the DOM suites can make. That is what the screens checks are for.
- **A green run is not a passing suite if it flakes.** `e2e:lifecycle` was
  green two runs in three while a real bug was live. Judge it on a series, not
  on one result.
- **A fallback in a test is usually a bug in disguise.** A branch that says "try
  the new way, else the old way" passes when the thing under test is *absent*,
  which is the one case worth failing on. Both instances on 2026-08-16/17 were
  in this suite: `e2e:legacy` sent a `setBusy` after the mic stopped and so
  papered over an `offlineHold` that never cleared — a green run there was not
  evidence the defect was fixed; and `clickNewSession` fell back to the overflow
  menu, which looked like host-version tolerance but was not, because
  `#session-new` comes from the vendored `chat.js` the **relay** serves and
  therefore tracks the deploy, never the installed extension. That fallback
  could only have fired if the injection broke, and it would have clicked the
  menu and passed. Both removed; assert the one true path and let it fail loudly.
- **Don't assert a control that only exists in some states.** The conversation
  overflow renders `if (record)`, so with no active conversation it is correctly
  absent. An assertion that opened it passed only while New was itself the thing
  rendering it. When coverage needs a state the suite is not in, move the
  coverage to a harness that has that state — the extension's DOM tests here —
  rather than guarding it with a conditional, which reintroduces the fallback
  above.

## Relay tests

Run these commands from `afkpilot`.

| Command | What it exercises | When to run |
| --- | --- | --- |
| `npm run typecheck` | TypeScript compilation without output. | Any relay source or test change; included in `gate`. |
| `npm run check:vendor` | Vendored manifest and file hashes, plus sibling extension-source comparison when the sibling checkout exists. | Any shared-renderer or vendor change; also included by `build` and `npm test`. |
| `npm test` | `check:vendor` followed by the Vitest suite: frame parsing, hub routing, auth and limits, REST/WebSocket server behavior, download/update routes, DOM helpers, and store adapters. Live Clerk and Supabase integration files skip when their credentials are absent. | Every relay change and every UI synchronization. This is the fast baseline. |
| `npm run e2e:touch` | A real Chromium page under a phone/coarse-pointer profile. It asserts remote layout, touch targets, input sizing, theme behavior, and critical mobile interactions. | Any renderer, `web/chat.html`, touch, responsive, or browser-shell change; always after `sync-ui`. |
| `npm run e2e:legacy` | The legacy-host compatibility scenario plus the tab-identity scenario. It proves the browser can tolerate missing optional capabilities/frames and that multiple tabs retain independent client routing. | Protocol, shim, capability, routing, or shared-renderer changes; always after `sync-ui`. |
| `npm run e2e:screens` | Scripted Chromium UI states and geometry assertions at the maintained screen profiles; writes diagnostic images to `.screens` unless overridden. | Visual/layout changes and after `sync-ui`. Inspect failures as visual artifacts, not only assertion text. |
| `npm run e2e:downloads` | Desktop download-page behavior and update-feed selection against controlled local release responses. | Download page, GitHub release resolution, update metadata, platform/architecture selection, or routing changes. |
| `npm run e2e:signin` | Connecting an agent from a phone, end to end: a real Chromium phone profile clicks Connect, the click is asserted to ARRIVE at a scripted host through the relay, and the device URL and code are asserted to come back and render. Also measures the contrast of the sign-in link against its own button, which is how it caught the link shipping as 1.12:1 blue-on-blue. Screens land in `.screens/signin`. | Anything touching the onboarding panel, the provider-login capability, or `remote-policy.ts`'s classification of `runGrokLogin`. The DOM suites cover each half of this and structurally cannot see the wire between them — which is exactly where a `host-local` misclassification hides. |
| `npm run e2e:cloud` | The device picker with cloud environments in it, in a real browser at desk and phone widths. Asserts the two things most likely to regress — a sleeping environment must not be labelled asleep, and its button must not be disabled — plus that a cloud row never mentions Linux or a desktop app, that its icon occupies space, and that an ordinary offline laptop still says what it always said. Screens in `.screens/cloud-picker`. | Anything touching device availability, the picker, or `src/environments.ts`. The unit suites prove the decision; only a browser proves a person sees a usable row. |
| `npm run e2e:browser` | Full local browser flow against a locally started relay with real Clerk and Supabase test configuration, including browser authentication, linking, WebSockets, and revocation. Artifacts go to `e2e-artifacts` by default. | Authentication, device, persistent-store, link page, or end-to-end browser changes; and as part of the release gate. This is not the keyless path. |
| `npm run e2e:lifecycle` | Real relay + real Chromium + the sibling repo's real desktop host. Walks new session → send → second same-repo session → refresh restore → host restart → reconnect → repo switch. Locally skips loudly (exit 0) when `../grok-build-vscode` (or `GROK_BUILD_VSCODE`) is absent. `LIFECYCLE_REQUIRE_HOST=1` makes a missing host a failure rather than a skip. There is **no CI job for this** — the workflow is one `gate:ci` job — so the local gate before a promote is the only place it runs. `LIFECYCLE_INVERT` is the invert-verify hook (see the script header). | Restore, outbox, host restart, repo isolation, or anything a stub host cannot die in the middle of. Included in `gate`. Not in `gate:ci` — that job is a bare clone with no sibling checkout. |
| `npm run gate` | `typecheck`, `npm test`, then touch, legacy, browser, downloads, screenshot, and lifecycle E2E suites. | Mandatory local relay release gate before promotion. Its `e2e:browser` leg is the only place the authenticated flow runs, so CI cannot replace it. `e2e:lifecycle` skips loudly without the sibling checkout unless `LIFECYCLE_REQUIRE_HOST` is set. |
| `npm run gate:ci` | `gate` without `e2e:browser` and without `e2e:lifecycle`. | What the single `gate` job in `.github/workflows/ci.yml` runs on a bare clone. `e2e:browser` needs Clerk credentials; `e2e:lifecycle` needs the sibling extension checkout. Neither absence is covered by another job — the local `npm run gate` before a promote is what covers them. |
| `npm run smoke -- <url>` | Read-only deployed-service checks: health and public pages/config, link-code shape, expected WebSocket refusals, and download/update reachability. | After a development or production deployment. Pass the URL explicitly. |
| `npm run smoke:auth -- <url>` | Authenticated canary: real session, link approval, device listing, uplink/client connection, and revocation. | After an authentication-sensitive deployment and before relying on a production promotion. Pass an explicit URL and canary credentials. |
| `npm run smoke:keepalive -- <url> [busySeconds] [quietSeconds]` | Opens the caller's cloud environment on a real deployment and watches the machine's status through both halves of the promise: used once a minute it must stay `running`; left alone it must fall asleep. ~10 minutes. Needs canary credentials and `SPRITES_TOKEN`. Measured 2026-08-28: `running` for all 300 busy seconds, asleep 60s after the last traffic. | After anything touching the hold, the waker, or what counts as activity. It buys and wakes a real machine, so it is an operator check rather than part of any gate — and it is the only thing that tests the promise the product is sold on, end to end. |

`npm run build` and `npm test` both invoke `check:vendor`. A stale or hand-edited `web/vendor/` therefore fails before TypeScript or Vitest can give a misleading green result.

The keyless path covers most local iteration, including the mock verifier and in-memory stores. `e2e:browser`, the live Clerk/Supabase Vitest cases, and `smoke:auth` intentionally require test-service credentials. See [variables and secrets](variables-secrets.md); never substitute production credentials into local tests.

## Extension tests

Run these commands from `grok-build-vscode`.

| Command | What it exercises | When to run |
| --- | --- | --- |
| `npm test` | Vitest unit and component suites for ACP clients/backends, provider resolution, remote policy, host-independent logic, fake CLI scenarios, and DOM renderer behavior. | Every extension change. |
| `npm run test:watch` | The same Vitest family in watch mode. | Local iteration only; use `npm test` for a finite gate result. |
| `npm run test:integration` | Compiles and launches a real VS Code extension host, then runs the integration suite. GitHub Actions runs it on Linux under `xvfb-run`. | Host API, activation, commands, webview, workspace, storage, or packaging changes; required by CI. |
| `npm run test:desktop` | Serial Playwright tests against a real Electron window with controlled provider processes and desktop host services. | Electron host, IPC, window policy, file panel, desktop provider, or shared-renderer changes. |
| `npm run e2e:screens` | A real Electron application driven through maintained fake-CLI scenarios, with geometry assertions and screenshots. | Renderer, responsive layout, project rail, file panel, or desktop chrome changes; before a desktop release that affects UI. |
| `npm run test:live` | Headless live-CLI harness compiled from `scripts/live-tests.cjs`; it verifies real provider protocol assumptions outside fake processes. | Provider/ACP updates and the maintained extension release script. It requires the appropriate local CLI and account. |
| `npm run smoke:live` | Observational smoke of the real Electron app and real Grok CLI, including a real turn and desktop/session/file-panel evidence. | Before desktop release when provider or end-to-end desktop behavior changed. It is intentionally not a deterministic unit gate. |
| `npm run test:perf` | Opt-in performance Vitest configuration. | Performance-sensitive renderer, history, parsing, or session work; compare results in a controlled environment. |
| `npm run check:vsix` | Builds and inspects the packaged extension artifact for required and forbidden contents. | Packaging, dependency, asset, or release-script changes; before publishing a VSIX. |

`npm run compile` is the extension TypeScript build. The CI test job runs compile, `npm test`, and VSIX packaging; the separate integration job runs `test:integration`.

## Gate selection

### Ordinary pull request

For a relay-only change, run `npm test` plus the focused E2E command for the affected boundary. Before a change is eligible for relay promotion, run the full `npm run gate` and record the result for review. `e2e:lifecycle` is part of that gate; without a sibling `grok-build-vscode` checkout it prints why and exits 0. CI covers the real run via the `lifecycle` job, which checks out both public repos at their default-branch tips (no secrets). That job cannot pass until the host-side lifecycle contract is on the sibling's default branch — the same release-order rule as relay-before-extension.

For an extension change, run `npm test` and the appropriate integration or desktop suite locally. The pull request then receives the GitHub Actions unit/package and Linux/xvfb integration jobs.

### After `sync-ui`

A shared-renderer change starts in `grok-build-vscode/media/`. Test it in the extension, then synchronize from the relay and run at least:

```sh
# grok-build-vscode
npm test
npm run test:desktop
npm run e2e:screens

# afkpilot
npm test
npm run e2e:touch
npm run e2e:legacy
npm run e2e:screens
```

Add `e2e:browser` when the renderer change affects authentication, linking, shim transport, or remote-only behavior.

### Before a relay promotion

Run `npm run gate` locally. After the branch deploys, run `npm run smoke -- <url>`; add `smoke:auth` for session, device, entitlement, or WebSocket enforcement changes, and `smoke:keepalive` for anything touching the hold, the waker, or what counts as activity.

### Before an extension release tag

Confirm the GitHub Actions checks, run applicable real Electron coverage, and run the live provider check when ACP or provider behavior changed. The desktop branch dispatch described in [delivery](CICD.md) should produce test installers before the tag dispatch attaches release artifacts.
