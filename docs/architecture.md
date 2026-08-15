# Architecture

`afkpilot` is a WebSocket relay and browser host for a coding-agent UI that runs on a developer's machine. The host extension makes one outbound uplink; authenticated browser clients connect to the relay and exchange the same webview messages used locally.

This document is the map of that system. Follow its links for implementation detail.

## System boundary

```text
IDE or Electron host
  ACP client -> provider process
  shared chat renderer
  remote-policy.ts
  remote-uplink.ts
        |
        | outbound /uplink WebSocket
        v
relay Hub (in memory) <-> authenticated /client WebSocket <-> remote browser
        |
        +-> device registry
        +-> aggregate usage counters
```

The provider process, workspace access, terminal access, approvals, and host-native actions remain on the developer's machine. The relay pairs an uplink with browser clients, authenticates the browser side, checks device ownership and configured entitlement, and forwards frames. It does not run a coding agent.

The relay is routing-policy-free by design. Capability and message policy live at the trusted host boundary in the extension's `src/remote-policy.ts`; see [Grok Build integration](grok-build-integration.md). The server still validates transport envelopes and applies connection, payload-size, and usage controls. “Policy-free” does not mean that malformed frames are forwarded blindly.

## Components

| Area | Relay source | Responsibility |
| --- | --- | --- |
| Process entry | `src/main.ts` | Read runtime configuration, select concrete stores and verifier, start the HTTP/WebSocket server. |
| HTTP and upgrades | `src/server.ts` | Serve browser assets and REST routes; enforce authentication and ownership at `/client`; accept device credentials at `/uplink`. |
| Live routing | `src/hub.ts` | Pair one device uplink with zero or more browser clients and route per-client frames. |
| Wire types | `src/frames.ts` | Define and parse the relay envelope mirrored by the extension. |
| Session verification | `src/auth.ts`, `src/auth-clerk.ts` | Provide the verifier seam, local mock verifier, Clerk verification, claim parsing, issuer checks, and authorized-party checks. |
| Device credentials | `src/device-keys.ts`, `src/devices.ts`, `src/devices-supabase.ts` | Mint, hash, verify, list, and revoke device tokens in memory or Supabase. |
| Limits | `src/limits.ts`, `src/usage.ts`, `src/usage-supabase.ts` | Apply per-user connection and aggregate message controls in memory or Supabase. |
| Distribution routes | `src/downloads.ts`, `src/update-feed.ts` | Resolve public desktop release assets and update metadata. |
| Browser host | `web/chat.html` | Supply the remote shell, browser authentication, webview compatibility shim, and `/client` connection. |
| Shared renderer | `web/vendor/` | Committed output of `npm run sync-ui`; generated from extension media and never edited directly. |

The extension-side modules and provider boundary are documented in [Grok Build integration](grok-build-integration.md) and [Codex integration](codex-integration.md). The IDE, desktop, and browser boot paths are compared in [surfaces](surfaces.md).

## Connection flows

### Link a host

The extension requests a short-lived link code, opens the relay's link page in the user's browser, and polls the link status. The browser supplies a verified session. Approval creates a device record owned by that session's user and returns the device token once to the polling extension. The extension stores it in the host secret store and opens `/uplink?token=...`.

The full credential and close-code sequence is in [authentication](authentication.md).

### Attach a browser client

The remote page authenticates in the browser and upgrades `/client?device=...`. The relay verifies the `__session` cookie, applies the configured access checks, confirms that the requested device belongs to that user, and attaches the connection to the in-memory `Hub`. If an uplink is already present, the host receives a per-client ready frame and sends state for that browser.

### Forward a turn

Browser messages pass through the relay envelope to `remote-policy.ts` on the host before entering the ordinary sidebar message handler. Host messages pass through the outbound half of the same policy, which may mirror, transform, or suppress them before `remote-uplink.ts` writes to the socket.

The relay does not persist prompts, source code, responses, or per-message metadata. These payloads exist only while a live WebSocket frame is being handled or buffered by an active connection. Persistent relay records are limited to device ownership and aggregate usage counters. See [security](security.md) for the corresponding trust boundary.

## Shared contracts

There are two deliberate cross-repository contracts:

1. `src/frames.ts` mirrors the extension's `src/remote-frames.ts`. Compatible changes are additive and consumers detect fields or capabilities, not a product-version string. An incompatible protocol change requires `REMOTE_PROTO_VERSION` to move in both files.
2. The extension's renderer is copied into `web/vendor/` by `npm run sync-ui`. The generated tree is committed so a relay build is self-contained.

The relay must be deployed before an extension release that depends on a new frame. Details and contributor workflow are in [repositories](repositories.md).

## Runtime modes

With no Clerk or Supabase configuration, `src/main.ts` selects `MockSessionVerifier`, `InMemoryDeviceRegistry`, and `InMemoryUsageStore`. This is the default contributor mode and requires no external account. Configuring the complete Supabase variable pair switches both persistent stores; configuring `CLERK_SECRET_KEY` switches session verification. See [variables and secrets](variables-secrets.md).

## Further reading

- [Relay protocol](relay-protocol.md) for frame shapes and compatibility rules.
- [Authentication](authentication.md) and [security](security.md) for credentials and enforcement.
- [Testing](test.md) for the checks that exercise each boundary.
- [Delivery](CICD.md) for repository-specific release flow.
- [Engineering documentation index](README.md) for the complete contributor set.
