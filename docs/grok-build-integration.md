# Grok Build integration

The extension contains the trusted endpoint of remote control. Its relay integration is intentionally thin: define the shared transport, decide which ordinary webview messages may cross the remote boundary, maintain one outbound socket, and keep the host awake while it may need to answer.

Paths in this document are in `grok-build-vscode`.

## Modules

| Module | Role |
| --- | --- |
| `src/remote-frames.ts` | Wire mirror for the relay envelope, parsers, protocol version, and relay URL resolution. |
| `src/remote-policy.ts` | Pure and exhaustive classification of inbound `WebviewMsg` and outbound `HostMsg` values. |
| `src/remote-uplink.ts` | Outbound WebSocket lifecycle, reconnects, snapshots, client routing, and the final policy choke point. |
| `src/keep-awake.ts` | Best-effort platform sleep inhibition while the linked host or an active turn must remain reachable. |
| `src/sidebar.ts` | Link/unlink commands, device-token secret storage, uplink construction, and reuse of the normal webview message handler. |

The public relay endpoint is the committed `REMOTE_RELAY_URL` value, `wss://afkpilot.com`, in `remote-frames.ts`. There is no user-facing relay URL setting. A source development host may set `GROK_RELAY_URL`; `resolveRelayUrl()` deliberately ignores that override in production extension and packaged desktop modes.

## Message path

The local sidebar and a remote browser use the same `WebviewMsg` and `HostMsg` unions. A remote inbound payload is not dispatched directly:

1. `remote-uplink.ts` parses the relay envelope and associates it with a client ID.
2. `authorizeRemoteWebviewMsg()` in `remote-policy.ts` classifies and validates the message for the remote tier and project scope.
3. An allowed message enters the same sidebar handler used by the local webview.
4. Host responses pass through `prepareRemoteHostMsg()`, including project authorization and media transformation, before they are sent to one client or broadcast.

`INBOUND_DISPOSITION` is a `Record<WebviewMsg["type"], ...>` with `control`, `view`, `propose`, `full`, and `host-local` classifications. `OUTBOUND_DISPOSITION` likewise classifies every `HostMsg` as `mirror`, `media`, or `host-local`. Because the maps are exhaustive, adding a message type creates a compile-time obligation to decide its remote behavior.

This is where capability policy belongs. Host-local actions such as native pickers, local editor operations, configuration changes, local sign-in, microphone setup, and workspace mutations that have no safe remote meaning are denied or suppressed. Project-bearing messages are also checked against the catalog and client scope published by the host. Media that is safe to mirror is converted from a webview-only URI into a bounded inline representation; unsupported host-local output is omitted.

The relay therefore remains independent of editor and provider semantics. It routes an envelope and enforces connection-level controls; it does not decide whether a webview command is safe.

## Uplink behavior

`RemoteUplink` opens a client WebSocket to `/uplink?token=...`. The extension never listens on an inbound port. After opening, it sends `hello` with the mirrored protocol version and publishes host state. The relay reports browser arrivals and departures by client ID, allowing the extension to send a targeted snapshot and later target responses.

Unexpected disconnects use bounded reconnect backoff. A close that identifies an invalid or revoked device token stops the uplink and returns the extension to the relink path; transient closes retry. Authorization is checked again at the socket write boundary so queued or asynchronous output cannot bypass the policy decision.

## Link and unlink commands

The extension contributes:

- `grok.linkRemote` — “AFK Pilot: Link this device”.
- `grok.unlinkRemote` — “AFK Pilot: Unlink this device”.

Linking posts host metadata to `/api/link/start`, opens the returned link page in the system browser, and polls the status endpoint every two seconds for up to five minutes. On approval, the relay returns a device token once. The extension saves that token in the host's secret storage and starts the uplink.

Unlinking makes a best-effort authenticated request to `/api/device/unlink`, then removes the local secret and tears down the uplink even if the network request fails. This ensures that “unlink” always stops the current host from reconnecting; server-side revocation is completed when the request reaches the relay. See [authentication](authentication.md) for credential details.

## Keep-awake behavior

The `grok.remote.keepAwake` setting defaults to enabled. `KeepAwake` inhibits system sleep while the host is linked or while any local or remote turn is in flight. It is best effort and does not keep the display awake.

The implementation uses:

- macOS: `caffeinate -i -s -w <host-pid>`;
- Windows: `SetThreadExecutionState` with continuous and system-required flags;
- Linux: `systemd-inhibit` for idle and sleep, with an idle-only fallback;
- WSL: no inhibitor, because keeping the Windows host awake is outside the Linux guest.

The helper follows the host process lifetime, and failures are logged rather than failing the agent session.

## Deliberate omissions

The extension does not:

- expose a production relay endpoint setting;
- accept inbound network connections or configure local port forwarding;
- verify Clerk sessions or implement browser authentication;
- own the relay's device registry or usage store;
- persist remote message payloads at the relay boundary;
- move provider, workspace, approval, or filesystem authority into the relay;
- infer capability support from release versions.

The browser sees only what the extension's current policy and advertised capabilities permit. Transport details are in [relay protocol](relay-protocol.md), and the three hosts are compared in [surfaces](surfaces.md).
