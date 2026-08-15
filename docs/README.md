# Engineering documentation

This directory documents how to build, test, and contribute to the relay and its companion extension. It is written for contributors working from source. Product usage instructions belong with the extension package.

Start with [architecture](architecture.md) for the system boundary, then use the guide that matches the change:

- [Repositories](repositories.md) — repository ownership, the mirrored wire contract, UI vendoring, and release order.
- [Grok Build integration](grok-build-integration.md) — the extension's remote-control client, policy gate, link flow, and keep-awake support.
- [Codex integration](codex-integration.md) — the ACP backend seam and provider selection in the extension.
- [Surfaces](surfaces.md) — IDE, Electron desktop, and remote browser boot paths and capabilities.
- [Design](design.md) — the implemented CSS tokens, icon scale, touch targets, responsive rules, and browser theme.
- [Authentication](authentication.md) — session verification, device credentials, ownership, and connection enforcement.
- [Variables and secrets](variables-secrets.md) — runtime and test environment variables, including the account-free local path.
- [Testing](test.md) — unit, integration, browser, desktop, smoke, and release gates across both repositories.
- [Delivery](CICD.md) — contributor CI and maintainer deployment and release flows.
- [Relay protocol](relay-protocol.md) — frame-level transport contract.
- [Security](security.md) — threat model and security invariants.

The documentation assumes the repositories are sibling directories named `afkpilot` and `grok-build-vscode`. Paths are relative to those roots unless stated otherwise.
