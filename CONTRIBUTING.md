# Contributing

Thank you for contributing. This repository contains the relay and remote browser client; the VS Code/Cursor extension and Electron desktop host live in the sibling `grok-build-vscode` repository. Read [the repository map](docs/repositories.md) before changing a contract shared by both.

## Local setup

Use Node.js 20 and npm. Clone the repositories beside one another:

```text
work/
├── grok-remote/
└── grok-build-vscode/
```

The relay has an account-free development path:

```sh
cd grok-remote
npm install
npm start
```

With no Clerk or Supabase variables, it listens on `127.0.0.1:8787`, accepts mock sessions, and keeps device and usage state in memory. See [variables and secrets](docs/variables-secrets.md) before enabling external services.

To compile and test the extension:

```sh
cd ../grok-build-vscode
npm install
npm run compile
npm test
```

The committed files under `web/vendor/` are generated from the extension renderer. Never edit them by hand. When shared UI source changes, run `npm run sync-ui` in the relay and test both repositories as described in [testing](docs/test.md).

## Before opening a pull request

Keep a change within the repository that owns it. Protocol or shared-renderer work may require coordinated changes in both repositories; [repositories](docs/repositories.md) explains the ordering.

Run the smallest applicable checks while iterating, then the repository's required gate:

- Extension pull requests run unit, package, and Linux/xvfb integration jobs in GitHub Actions.
- The relay has no CI. Run `npm run gate` locally before asking a maintainer to promote relay changes.

Do not commit `.env`, credentials, test accounts, deployment URLs, build artifacts, or generated screenshots unless a maintainer explicitly requests the artifact. See [delivery](docs/CICD.md) for release responsibilities and [security](docs/security.md) for the security boundary.
