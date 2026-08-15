# Repository map

The system is split across two repositories. Contributors should normally clone them as siblings because the relay's UI synchronization and vendor checks use that layout by default.

```text
work/
├── grok-remote/
└── grok-build-vscode/
```

## Ownership

| Repository | Owns |
| --- | --- |
| `grok-remote` | HTTP and WebSocket relay, authentication and device registry adapters, aggregate usage controls, remote browser shell, deployment configuration, Supabase migrations, and the committed copy of the shared renderer. |
| `grok-build-vscode` | VS Code/Cursor extension, Electron desktop host, ACP provider integration, workspace and terminal operations, remote capability policy, outbound uplink, and the source copy of the chat renderer. |

The extension repository is the source of truth for anything that runs on the developer's machine. The relay repository is the source of truth for transport, browser hosting, server-side authentication, and persistence.

## Mirrored wire contract

`grok-remote/src/frames.ts` and `grok-build-vscode/src/remote-frames.ts` intentionally mirror the relay envelope. Both currently declare `REMOTE_PROTO_VERSION = 1`.

The envelope carries:

- uplink registration and routing frames: `hello`, `host`, `host-to`, and `snapshot`;
- relay-to-host lifecycle and routing frames: `client-ready`, `client-left`, `msg`, and `clients`;
- raw `HostMsg` and `WebviewMsg` payloads between the host and each browser client.

The complete frame contract is in [relay protocol](relay-protocol.md). When changing it:

1. Prefer an additive field or frame that older peers can ignore.
2. Gate behavior on the presence of that field, frame, or an advertised capability. Do not infer support from extension, desktop, or relay release versions.
3. Update both mirror files in the same coordinated change.
4. Leave `REMOTE_PROTO_VERSION` unchanged for compatible additions.
5. For an incompatible change, bump `REMOTE_PROTO_VERSION` in both repositories and add explicit compatibility tests.

The parsers reject a peer whose protocol is newer than the local implementation. That protects old clients from silently misreading an incompatible future protocol; it is not a substitute for capability detection within a compatible protocol.

## Shared UI vendoring

The renderer originates under `grok-build-vscode/media/`. From the relay repository, `npm run sync-ui` runs `scripts/sync-ui.mjs`, whose default source is the sibling extension checkout. It copies the declared renderer assets into `web/vendor/` and writes `web/vendor/ui-vendor-manifest.json` with source revision and file hashes.

`web/vendor/` is generated, committed output. Never hand-edit it. Make the change in the extension repository, run `npm run sync-ui` in the relay, and commit the resulting vendor update with the relay change. `npm run check:vendor`, which is included by the build and tests, checks the manifest, hashes, and the sibling source when that checkout is available.

`web/chat.html` is not vendored. It owns the browser-only shell, authentication bootstrap, responsive layout, and webview compatibility shim. Its element structure must continue to satisfy the expectations of the vendored `chat.js`.

After a synchronization, run the UI-focused checks in [testing](test.md), including touch, legacy-host, screenshot, and extension renderer coverage.

## Release ordering

The relay must ship first when an extension change depends on a new relay frame or server behavior:

```text
add compatible relay support -> deploy relay -> release dependent extension
```

Old extensions must remain valid against the new relay during that interval. A renderer-only synchronization may still require coordinated tests, but it does not change the transport contract by itself.

Branch, promotion, and release mechanics are documented in [delivery](CICD.md).

## Licensing

`grok-build-vscode` has used the FSL-1.1-MIT license since version 2.0.0; the repository's tags and `LICENSE` file are authoritative for each version. For `grok-remote`, see [LICENSE](../LICENSE).
