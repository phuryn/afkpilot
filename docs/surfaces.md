# Application surfaces

The same chat renderer appears in three hosts: an IDE webview, the Electron desktop application, and the remote browser client served by the relay. The renderer is shared; the host, bootstrap, available capabilities, and security boundary are not.

## IDE

`grok-build-vscode/src/extension.ts` activates the extension and registers the chat `WebviewViewProvider`. `GrokSidebar.resolveWebviewView()` configures the VS Code webview and calls the shared `getHtml()` renderer bootstrap. `VSCodeHost` implements editor, workspace, terminal, storage, dialogs, secrets, URI, and command services through the VS Code API.

VS Code and Cursor follow this same path. The body carries the `desk` class for compact panel density. Project navigation lives in a separate projects-rail webview, while the chat webview remains scoped to its current workspace. The IDE host does not advertise the in-window multi-workspace layout capability, so the shared renderer does not mount the desktop file-panel shell there.

## Desktop

`grok-build-vscode/src/desktop/main.ts` boots after Electron's app-ready event, creates the window, and constructs `ElectronHost`, `ElectronWebview`, and the same `GrokSidebar`. The sidebar still calls `getHtml()`; Electron's webview adapter supplies the VS Code-like message and URI surface needed by that HTML.

Desktop-specific modules under `src/desktop/` implement window security, preload IPC, safe secret storage, native dialogs, terminal launch, file selection, file tree operations, updater behavior, and the `app-resource:` asset path. Because the desktop host can switch workspace folders, the shared renderer mounts the projects rail and dockable file panel in the same window.

## Remote browser

The relay serves `web/chat.html` at `/chat`. That page owns browser session setup, the remote shell, responsive layout, and a compatibility implementation of `window.acquireVsCodeApi()`. The shim carries renderer `postMessage` calls over the authenticated `/client?device=...` WebSocket and delivers host messages back as webview message events.

Before the vendored renderer starts, the page sets its remote-client marker. It then loads the committed assets under `web/vendor/`, including the extension's chat, settings, file-panel, syntax-highlighting, MathJax, and Mermaid code. The browser shell's DOM deliberately mirrors the elements expected by `GrokSidebar.getHtml()`, but `web/chat.html` itself is maintained in the relay repository.

The browser has no direct workspace or provider authority. Every action returns through the relay to `remote-policy.ts` and then to the ordinary host handler. Authentication and device ownership are described in [authentication](authentication.md).

## What is shared

`grok-build-vscode/media/chat.js` and `media/chat.css` are the renderer source for all three surfaces. The file-panel and supporting media follow the same ownership. IDE and desktop load them directly from the extension; the relay receives a committed copy through `npm run sync-ui`.

Shared renderer code owns conversation rendering, composer behavior, models and modes, cards, history, project rail behavior, file browsing UI, settings UI, and the `HostMsg`/`WebviewMsg` contract. Host adapters own privileged operations and translate them into that contract.

See [repositories](repositories.md#shared-ui-vendoring) for synchronization and [design](design.md) for the CSS rules that intentionally vary density and layout.

## Capability differences

| Capability area | IDE webview | Electron desktop | Remote browser |
| --- | --- | --- | --- |
| Privileged host | VS Code/Cursor APIs through `VSCodeHost`. | Electron IPC and native services through `ElectronHost`. | None; all privileged work is performed by the linked IDE or desktop host. |
| Project navigation | Separate projects-rail view; chat is one workspace. | Projects rail in the application window and host-supported workspace switching. | Projects drawer driven by the linked host's published repository catalog. |
| File panel | IDE-native editor and picker flows; no shared in-chat dock. | Shared dockable file panel with desktop file services. | Shared panel rendered as a dock at wide widths and a full-screen overlay below 900 px, subject to remote policy. |
| Authentication | Provider and extension connection state on the local machine. | Provider and desktop connection state on the local machine. | Browser session plus ownership of a linked device. |
| Remote transport | May originate the outbound uplink. | May originate the outbound uplink. | Terminates the browser side of that uplink through the relay. |
| Host-local actions | Available when the VS Code host implements them. | Available when the Electron host and desktop policy implement them. | Denied or omitted when classified `host-local`. |

These differences are capability-driven. The renderer checks advertised `initialState.capabilities`, the presence of optional fields, and the arrival of frames such as repository or pinned-session state. It does not compare extension, desktop, or relay version strings to decide whether a feature exists. A surface may also branch on an inherent environment fact—such as “this is the remote browser”—but protocol evolution remains additive and capability-detected.
