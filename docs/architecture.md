# Architecture

`afkpilot` is a WebSocket relay and browser host for a coding-agent UI whose host runs in an IDE, a desktop app, or a Sprites cloud environment. The host makes one outbound uplink; authenticated browser clients connect to the relay and exchange the same webview messages used locally.

This document is the map of that system. Follow its links for implementation detail.

## System boundary

```text
IDE or Electron host (developer machine or Sprites environment)
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
        +-> cloud environment / pool records and scheduled wake timestamp
        +-> Sprites provisioning, wake and exec holds
```

The provider process, workspace access, terminal access, and approvals remain in the host process. For cloud environments that process runs inside the user's Sprite. The relay pairs an uplink with browser clients, authenticates the browser side, checks device ownership and configured entitlement, and forwards frames. It also provisions and wakes cloud hosts and holds them running while active. It does not execute the coding agent inside the relay process.

The relay is routing-policy-free by design. Capability and message policy live at the trusted host boundary in the extension's `src/remote-policy.ts`; see [Grok Build integration](grok-build-integration.md). The server still validates transport envelopes and applies connection, payload-size, and usage controls. “Policy-free” does not mean that malformed frames are forwarded blindly.

## Components

| Area | Relay source | Responsibility |
| --- | --- | --- |
| Process entry | `src/main.ts` | Read runtime configuration, select concrete stores and verifier, start the HTTP/WebSocket server. |
| HTTP and upgrades | `src/server.ts` | Serve browser assets and REST routes; enforce authentication and ownership at `/client`; accept device credentials at `/uplink`. |
| Live routing | `src/hub.ts` | Pair one device uplink with zero or more browser clients and route per-client frames. |
| Wire types | `src/frames.ts` | Define and parse the relay envelope mirrored by the extension. |
| Session verification | `src/auth.ts`, `src/auth-clerk.ts` | Provide the verifier seam, local mock verifier, Clerk verification, claim parsing, issuer checks, and authorized-party checks. |
| Device credentials | `src/device-keys.ts`, `src/devices.ts`, `src/devices-supabase.ts`, `src/device-verify-cache.ts` | Mint, hash, verify, list, and revoke device tokens in memory or Supabase. Production `verify()` memos the row (never the verdict) in a short-TTL in-memory cache so a reconnect storm is one lookup per TTL. |
| Limits | `src/limits.ts`, `src/usage.ts`, `src/usage-supabase.ts` | Apply per-user connection and aggregate message controls in memory or Supabase. |
| Distribution routes | `src/downloads.ts`, `src/update-feed.ts` | Resolve public desktop release assets and update metadata. |
| Browser host | `web/chat.html` | Supply the remote shell, browser authentication, webview compatibility shim, and `/client` connection. Non-terminal reconnects use a capped exponential backoff and do not retry while the tab is hidden. |
| Shared renderer | `web/vendor/` | Committed output of `npm run sync-ui`; generated from extension media and never edited directly. |
| Cloud lifecycle | `src/environment-provisioner.ts`, `src/environment-waker.ts`, `src/environment-keepalive.ts`, `src/presence.ts`, `src/wake-scheduler.ts` | Create and wake Sprites, hold them running during activity, track browser presence, and dispatch scheduled wakes. |
| Cloud inventory and installation | `src/environment-store.ts`, `src/environment-pool-store.ts`, `src/pool-filler.ts`, `src/pool-bootstrap.ts`, `src/environment-handover.ts`, `src/sprite-exec.ts` | Track owned environments and spare machines, build hosts, and deliver device identity through single-use handover codes. |

The extension-side modules and provider boundary are documented in [Grok Build integration](grok-build-integration.md) and [Codex integration](codex-integration.md). The IDE, desktop, and browser boot paths are compared in [surfaces](surfaces.md).

## Connection flows

### Link a host

The extension requests a short-lived link code, opens the relay's link page in the user's browser, and polls the link status. The browser supplies a verified session. Approval creates a device record owned by that session's user and returns the device token once to the polling extension. The extension stores it in the host secret store and opens `/uplink?token=...`.

The full credential and close-code sequence is in [authentication](authentication.md).

### Attach a browser client

The remote page authenticates in the browser and upgrades `/client?device=...`. The relay verifies the `__session` cookie, applies the configured access checks, confirms that the requested device belongs to that user, and attaches the connection to the in-memory `Hub`. If an uplink is already present, the host receives a per-client ready frame and sends state for that browser.

### Forward a turn

Browser messages pass through the relay envelope to `remote-policy.ts` on the host before entering the ordinary sidebar message handler. Host messages pass through the outbound half of the same policy, which may mirror, transform, or suppress them before `remote-uplink.ts` writes to the socket.

The relay does not persist prompts, source code, responses, or per-message metadata. These payloads exist while frames are handled or buffered for routing. Persistent relay records include device ownership, aggregate usage counters, cloud environment and pool lifecycle metadata, and a next-wake timestamp. Conversation content and agent credentials belong on the host. See [security](security.md) for the trust boundary and [cloud environments](cloud-environments.md) for the provisioning and sleep lifecycle.

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
