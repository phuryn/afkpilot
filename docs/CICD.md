# Delivery and release flow

The repositories ship differently. The relay uses branch-connected deployment services, a GitHub Actions gate, and a local release gate that covers authentication and host lifecycle beyond CI. The extension uses GitHub Actions for pull requests and a separate maintainer release process.

## What a contributor sees

### Relay pull requests

Pushes and pull requests targeting `main` (and pushes to `production`) run `.github/workflows/ci.yml`: Node.js 20, locked dependencies, a Chromium install for Playwright, then `npm run gate:ci`. That is the whole workflow — one job.

Two suites are therefore **not** covered by CI at all: `e2e:browser` needs Clerk credentials, and `e2e:lifecycle` needs a checkout of `phuryn/grok-build-vscode`. The local `npm run gate` before a promote is the only thing that runs them, which makes running it a real gate rather than a formality.

`gate:ci` is `gate` minus `e2e:browser` and minus `e2e:lifecycle`. `e2e:browser` drives the real Clerk sign-in modal and needs the dev Clerk and Supabase keys; without them the relay starts in mock mode and the suite fails its Clerk check. `e2e:lifecycle` needs a checkout of `phuryn/grok-build-vscode` (real desktop host) and runs locally. CI supplies no service credentials. Locally, Vitest's Clerk and Supabase integration tests can load `.env` and run against configured test services; choosing the `default` Vitest project excludes Supabase integration tests but still includes the Clerk canaries.

So the `gate` job does **not** cover the authenticated mile — ClerkJS hot-load, the sign-in modal, the `__session` cookie on the WebSocket upgrade, link approval and revocation — nor the cross-repo host-restart mile. Running `npm run gate` locally still covers the authenticated mile, and remains mandatory before promotion. Include the commands and results in the pull request so reviewers can distinguish an unrun gate from a failure.

Do not push a contributor branch to `production`. Deployment credentials, environment configuration, and production promotion remain maintainer responsibilities.

### Extension pull requests

Pushes and pull requests targeting `main` run `.github/workflows/ci.yml`:

- the test job uses Node.js 20, installs locked dependencies, compiles, runs `npm test`, and packages the VSIX;
- the integration job compiles the integration harness and runs `npm run test:integration` on Linux under `xvfb-run`, providing a real VS Code extension host in a virtual display.

These jobs do not publish a release. They establish that the source builds, unit tests pass, the package can be assembled, and the VS Code integration suite passes.

## Relay deployment

Relay deployment is not driven by the GitHub Actions workflows in `.github/workflows/` (those run the single `gate:ci` job). The checked-in `Dockerfile` supplies the Node.js 20 production image, and `railway.json` defines the Docker build, `/api/health` health check, and restart policy.

The environment flow is:

- a push to `main` deploys the development/staging relay;
- `production` is promote-only and must remain a fast-forward of `main`;
- a push to `production` deploys the Railway service and applies the production Supabase migrations.

Those branch bindings are configured in the deployment providers, not in a repository CI workflow. The repository contains the application build configuration and ordered SQL migrations under `supabase/migrations/`.

The maintainer promotion is mechanically a fast-forward:

```sh
git switch production
git merge --ff-only main
git push origin production
```

Before that push, the exact candidate commit must pass the full local gate, which requires the sibling host checkout:

```sh
npm run gate
```

After deployment, run `npm run smoke -- <url>`. Run `npm run smoke:auth -- <url>` as well when the change touches Clerk verification, link approval, device records, ownership, entitlement, persistent usage, or WebSocket admission. Neither command should embed a private deployment URL in source or documentation.

## Extension releases

The extension's ordinary CI is separate from release publication. Maintainers use the release scripts and package commands in `grok-build-vscode` to typecheck, run unit and integration coverage, verify live provider behavior where applicable, build the VSIX, create the release commit/tag, and attach the VSIX to the GitHub release.

Marketplace publication is an explicit maintainer action through `npm run publish`. The repository also provides `npm run publish:ovsx` for Open VSX. Publisher credentials are supplied by the maintainer environment and are never required for contributor builds or pull-request CI.

### Desktop two-dispatch workflow

`.github/workflows/desktop-release.yml` is manually dispatched and runs on macOS, Windows, and Linux. The Linux AppImage supplies the cloud host installation path.

Use it in two phases:

- Branch dispatch with no `release_tag`: build signed/notarized test installers where platform configuration permits and upload them as workflow-run artifacts. Download and exercise these before tagging.
- Tag dispatch with `release_tag`: run from the release tag and attach the installers and update metadata to the already-created GitHub release for that tag.

The first dispatch validates the exact desktop source without publishing installers to a release. The second makes tagged artifacts available and must not be used as a substitute for testing the branch artifacts. Signing and notarization configuration is maintainer-only; contributors can still run unsigned local Electron builds and tests.

## Cross-repository order

If an extension release depends on a new relay frame or server behavior, deploy the compatible relay change first, smoke it, and only then tag or publish the extension:

```text
relay gate -> relay development deploy -> smoke -> production promotion
  -> production smoke -> extension CI/release tests -> extension tag/publication
```

Protocol additions must remain safe for older extensions during the rollout. See [repositories](repositories.md#release-ordering) and [testing](test.md) for the exact gate matrix.

Record both repository commit IDs with a local lifecycle result: it exercises the sibling working tree, including any uncommitted changes. There is no cross-repository lifecycle CI job. The vendored UI manifest records its source revision, but it does not establish that the live cloud host is running that revision; verify the deployed host and boot-script versions separately when promoting cloud changes.
