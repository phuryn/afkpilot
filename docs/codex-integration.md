# Codex integration

The extension integrates Grok and Codex behind one Agent Client Protocol (ACP) client. Codex is not a parallel sidebar implementation: it is a provider-specific backend plugged into the same process, session, permission, filesystem, terminal, and renderer pipeline.

The source of truth is `grok-build-vscode`, especially `src/acp-backend.ts`, `src/acp.ts`, `src/acp-dispatch.ts`, `src/provider-ui.ts`, and `src/sidebar.ts`.

## The backend seam

`AcpProvider` is currently `"grok" | "codex"`. `AcpBackend` defines the provider-specific operations used by `AcpClient`:

- spawn and identify the provider process;
- normalize session creation/loading and prompt results;
- normalize streaming session updates and permission parameters;
- set model, reasoning effort, and mode;
- expose configuration state and decide whether a model change succeeded;
- list provider sessions;
- classify credential errors;
- declare whether the extension applies its client-side plan-mode gate.

`AcpClient` owns the shared ACP lifecycle: child-process JSON-RPC, initialization, session creation and loading, prompt/cancel, update dispatch, permission and question exchange, and host filesystem and terminal handlers. Its callers operate on normalized extension messages rather than provider wire variants.

## Provider-specific behavior

| Concern | Grok backend | Codex backend |
| --- | --- | --- |
| Process | Spawns the Grok CLI's ACP stdio command. | Spawns the pinned `@agentclientprotocol/codex-acp` adapter under Electron's Node executable and points it at the resolved Codex CLI. |
| Normalization | Mostly passes ACP values through the common shape. | Normalizes composite model/effort identifiers, usage, diffs, tool output, permissions, and paginated session history. |
| Configuration | Uses Grok session methods for model and mode. | Uses ACP configuration options for model, effort, and mode. |
| Plan gate | Uses the extension's client-side plan gate. | Leaves plan behavior to the adapter/provider. |
| Session listing | Uses the Grok session-list method. | Pages adapter results and filters them to the requested working directory. |
| Credentials | Uses Grok-specific error classification and connection flow. | Uses Codex-specific credential classification and connection flow. |

The Codex adapter package is pinned in the extension dependencies. The underlying Codex CLI is resolved in this order:

1. the explicit `grok.codexCliPath` contributor/user configuration;
2. a `codex` executable on `PATH`;
3. a platform binary bundled by an installed OpenAI/ChatGPT extension in supported VS Code, Cursor, and remote-server extension locations;
4. the extension-managed Codex installation.

Managed installation downloads the release selected by the extension source and verifies its SHA-256 digest before use. Provider UI reports both adapter and CLI versions so failures can be attributed to the correct layer.

## Provider resolution

Provider connections, discovered executables, project defaults, model caches, and session provenance meet in the sidebar:

- `PROVIDER_ORDER` is currently Grok, then Codex.
- Only connected and resolvable providers are offered for work.
- A connected project default wins; otherwise the first connected provider in that order is used, with Grok as the final compatibility fallback.
- An explicit provider in a webview request wins. Without one, a model ID that occurs in only one provider cache can identify the provider; ambiguous or unknown IDs fall back to the current provider.
- Session records retain provider identity. Combined history and model lists are normalized and deduplicated for the renderer, while loads return to the provider that owns the session.

Provider choice is therefore project- and session-aware, not a global substitution of one executable for another.

## Shared behavior

Both providers use the same:

- `Host` abstraction for VS Code and Electron;
- renderer and `HostMsg`/`WebviewMsg` protocol;
- project selection, history UI, file panel, plan/question cards, and permission cards;
- host filesystem, search, terminal, and editor implementations;
- remote-control policy and outbound relay transport;
- session lifecycle, cancellation, diagnostics, and update dispatch.

Provider-specific code should stop at normalization or process management. Adding provider branches inside the renderer for concepts already represented by the shared message protocol usually indicates that the backend seam is missing a normalization.

## Adding a third provider

A third provider requires coordinated extension work:

1. Extend `AcpProvider`, `PROVIDER_ORDER`, provider connection state, and the provider IDs allowed by the webview protocol.
2. Implement `AcpBackend` for spawning, normalization, configuration, history, and credential classification.
3. Add executable discovery or installation and the provider's sign-in or connection flow.
4. Teach sidebar provider resolution, project defaults, model aggregation, and session provenance about the new provider.
5. Add provider UI labels and status without changing the renderer's normalized concepts.
6. Test fake-process ACP behavior, provider resolution, session loading, desktop behavior, and remote policy.

No relay change is needed merely because a provider is added. A relay change is required only if the shared host/webview message contract gains a new remote-visible capability or frame; follow [the cross-repository protocol rules](repositories.md#mirrored-wire-contract).
