# UI design system

The design system is implemented in CSS rather than a separate token package. Its canonical shared sources are `grok-build-vscode/media/chat.css` and `media/file-panel.css`. The relay copies those files to `web/vendor/media/`; do not edit the vendored copies. Browser-only layout and theme values live in `grok-remote/web/chat.html`.

The values below are the implemented contract. Each value names the custom property, selector, or media query that defines it.

## Foundation

The shared renderer starts with a small spacing and radius vocabulary:

| Token or selector | Implemented value | Use |
| --- | --- | --- |
| `:root --pad` | `8px` | Base renderer inset. |
| `body.desk --pad` | `4px` | Compact IDE and Electron inset. The remote browser does not set `desk`. |
| `:root --gap` | `6px` | Common control/content gap. |
| `:root --radius` | `6px` | Small nested surfaces and inline code. |
| `:root --chat-radius-message` | `12px` | User message containers. |
| `:root --chat-radius-code` | `8px` | Block code and command surfaces. |

The visual model assumes the host provides VS Code color variables. It avoids fixed background assumptions in the shared renderer:

- `:root --chat-surface-user` is a `5%` `--vscode-foreground` tint over transparency; `--chat-surface-user-opaque` composites the same `5%` tint over `--vscode-sideBar-background`.
- `:root --chat-surface-code` mixes `60%` `--vscode-list-hoverBackground` with `6%` `--vscode-foreground`. The percentages intentionally total `66%`, producing a partly transparent wash.
- The remote page overrides `web/chat.html :root --chat-surface-user` and `--chat-surface-user-opaque` to `--vscode-input-background`, then `.msg.user .msg-bubble` adds a `1px` input-colored border. This makes a remote user message match the browser composer.

Project colors are also tokens under shared `:root`:

| Variable | Definition |
| --- | --- |
| `--repo-color-blue` | `var(--vscode-textLink-foreground)` |
| `--repo-color-teal` | `oklch(0.68 0.12 200)` at `72%`, mixed with `--vscode-foreground` at `28%` |
| `--repo-color-green` | `oklch(0.68 0.15 145)` at `72%`, mixed with `--vscode-foreground` at `28%` |
| `--repo-color-amber` | `oklch(0.76 0.14 85)` at `72%`, mixed with `--vscode-foreground` at `28%` |
| `--repo-color-coral` | `oklch(0.68 0.15 30)` at `72%`, mixed with `--vscode-foreground` at `28%` |
| `--repo-color-purple` | `oklch(0.64 0.15 305)` at `72%`, mixed with `--vscode-foreground` at `28%` |

## Bar icons and click areas

The standard icon-only control is deliberately consistent across chat, project rail, and file panel.

| Selector | Mouse layout | Glyph | Other rules |
| --- | --- | --- | --- |
| `.icon-btn` | `28px × 28px` | `.icon-btn svg`: `20px × 20px` | `8px` radius; transparent background; `2px` focus outline with `-2px` offset. |
| `.rail-icon-btn` | `28px × 28px` | `.rail-icon-btn svg`: `20px × 20px` | `8px` radius; the same transparent and focus treatment. |
| `.gfp-close`, `.gfp-icon-button`, `.gfp-toggle` | `28px × 28px` | their `svg`: `20px × 20px` | `8px` radius; the same transparent and focus treatment. |

Hover changes foreground color, not the button box. This keeps the `20px` bar-icon scale visible without painting a row of tiles.

Exceptions are explicit:

- `.session-name-edit svg` and `#session-head-edit svg` use a `16px × 16px` rename glyph.
- `.gfp-tab-close` is `22px × 22px` with a `14px × 14px` glyph for a mouse. Under `@media (hover: none) and (pointer: coarse)` it becomes `36px × 36px` with a `15px × 15px` glyph.
- Under `@media (hover: none), (pointer: coarse)`, `.send` becomes `36px × 36px` with a `19px × 19px` glyph and `.mic-btn svg` becomes `18px × 18px`.

Touch controls use a `36px` floor. The combined `@media (hover: none) and (pointer: coarse)` rule applies `min-width: 36px` and `min-height: 36px` to `.icon-btn`, `.rail-action-btn`, and `.rail-icon-btn`. File-panel bar controls receive the same `36px × 36px` size in `file-panel.css`.

The rail uses hit slop instead of widening row layout. In `@media (hover: none)`, `.rail-action-btn` and `.rail-session-actions .rail-action-btn` have a `36px × 36px` clickable box, `4px` padding, and `-4px` margin. The visible footprint remains `28px` while the hit area reaches the touch floor.

## Density and type

Pointer capability controls density. Width does not decide whether controls are finger-sized.

The base rail variables on `body` are:

| Variable | Mouse value | Touch value in `@media (hover: none)` |
| --- | --- | --- |
| `--rail-row-font-size` | `13px` | `15px` |
| `--rail-row-min-height` | `24px` | `36px` |
| `--rail-repo-font-size` | `14px` | `16px` |
| `--rail-repo-min-height` | `34px` | `40px` |

The unchanged rail tokens are `--rail-row-line-height: 1.5`, `--rail-row-gap: 6px`, `--rail-repo-font-weight: 600`, `--rail-repo-line-height: 1.45`, `--rail-indent: 16px`, `--rail-icon-size: 14px`, and `--rail-row-radius: 5px`.

The file panel follows the same touch scale. Under `@media (hover: none) and (pointer: coarse)`, `.gfp-panel` uses `15px`, `.gfp-markdown` uses `15px` with `1.55` line height, and `.gfp-filter` uses `16px`. The remote page's `@media (max-width: 899px)` raises `.card .card-title`, `.history-row-name`, and `.mode-item-label` to `16px`, while dense `.slash-name` and `.mention-name` stay at `14px`.

Remote touch rows that represent primary actions use `min-height: 44px` in the `web/chat.html @media (max-width: 899px)` rule. Icon-only row actions remain `36px × 36px`, keeping action density distinct from reading-row height.

### Input zoom rule

iOS Safari zooms a page when a focused input is smaller than `16px`. The shared `@media (hover: none) and (pointer: coarse)` rule sets `font-size: 16px` on `.rail-search`, `#rail-search`, `textarea#input`, `.input-highlight`, `.session-name-input`, `.history-search`, `.history-rename`, plan feedback, question-other, and confirmation inputs. The file panel independently sets `.gfp-filter` to `16px` under the same media condition. The remote page repeats `16px` for its mobile composer and editing inputs.

## Responsive layout

Viewport width controls structure:

- In `web/chat.html @media (max-width: 899px)`, the project rail is a fixed off-canvas drawer and the file panel is an overlay. `body #projects-rail` is `min(86vw, 330px)`.
- At `web/chat.html @media (min-width: 900px)`, the browser switches to its multi-column layout and supplies `#file-panel-dock`.
- `#app` has `max-width: 1120px`; `@media (min-width: 1152px)` adds its wide-screen border treatment.
- `.gfp-panel --gfp-width` is `280px`, with `.gfp-panel min-width: 200px`. In `file-panel.css @media (max-width: 899px)`, `.gfp-panel.gfp-overlay` becomes `100vw` and its header has `min-height: 51px`.
- Remote reading content uses `body.has-rail #messages`, `.composer`, and `#quota-wall` padding based on an `800px` measure. At `min-width: 900px`, `.messages` and `.composer` use `clamp(1.25rem, 4vw, 2.5rem)` horizontal padding; below that they add `5px` to `--pad`.

This separation matters for hybrid devices: a narrow mouse window keeps mouse density, while a wide touch device keeps touch targets. Layout follows width; interaction density follows `hover` and `pointer`.

## Browser theme variables

IDE and Electron surfaces receive `--vscode-*` values from their host theme. The browser has no VS Code theme provider, so `web/chat.html :root` defines a dark palette and `:root[data-theme="light"]` defines the light counterpart. The page mirrors light mode to `body.vscode-light` because the shared diff styles use that class.

| Variable | Dark `:root` | Light `:root[data-theme="light"]` |
| --- | --- | --- |
| `--vscode-foreground` | `#e6e6e6` | `#3b3b3b` |
| `--vscode-descriptionForeground` | `#9d9d9d` | `#6e6e6e` |
| `--vscode-editor-background`, `--vscode-sideBar-background` | `#1e1e1e` | `#ffffff` |
| `--vscode-editorWidget-background` | `#252526` | `#f8f8f8` |
| `--vscode-editorWidget-border`, `--vscode-widget-border` | `#454545` | `#d4d4d4` |
| `--vscode-panel-border` | `#2b2b2b` | `#e5e5e5` |
| `--vscode-focusBorder` | `#007fd4` | `#005fb8` |
| `--vscode-button-background` | `#0e639c` | `#005fb8` |
| `--vscode-button-foreground` | `#ffffff` | `#ffffff` |
| `--vscode-button-hoverBackground` | `#1177bb` | `#0258a8` |
| `--vscode-input-background` | `#313131` | `#ffffff` |
| `--vscode-input-foreground` | `#e6e6e6` | `#3b3b3b` |
| `--vscode-input-border` | `#3c3c3c` | `#cecece` |
| `--vscode-textLink-foreground` | `#3794ff` | `#005fb8` |
| `--vscode-textCodeBlock-background` | `#0a0a0a` | `#f6f6f6` |
| `--vscode-list-hoverBackground` | `#2a2d2e` | `#f2f2f2` |
| `--vscode-list-activeSelectionBackground`, `--vscode-list-inactiveSelectionBackground` | `#37373d` | `#e4e6f1` |
| `--vscode-list-activeSelectionForeground` | `#ffffff` | `#3b3b3b` |
| `--vscode-toolbar-hoverBackground` | `#383b3d` | `#e5e5e5` |
| `--vscode-badge-background` | `#4d4d4d` | `#cccccc` |
| `--vscode-badge-foreground` | `#ffffff` | `#333333` |
| `--vscode-errorForeground` | `#f48771` | `#cd3131` |
| `--vscode-charts-green` | `#4ec9b0` | `#388a34` |
| `--vscode-charts-blue` | `#3794ff` | `#1a85ff` |
| `--vscode-charts-yellow` | `#d7ba7d` | `#bf8803` |
| `--vscode-charts-red` | `#f48771` | `#cd3131` |
| `--vscode-scrollbarSlider-background` | `rgba(121,121,121,0.4)` | `rgba(100,100,100,0.35)` |
| `--vscode-scrollbarSlider-hoverBackground` | `rgba(100,100,100,0.7)` | `rgba(100,100,100,0.55)` |
| `--vscode-scrollbarSlider-activeBackground` | `rgba(191,191,191,0.5)` | `rgba(0,0,0,0.6)` |

`html` uses `#1a1a1a` outside the centered dark app and `:root[data-theme="light"]` uses `#fbfbfc`. Theme choice is stored under the browser-only `grok-remote-theme` local-storage key; this affects presentation only, not host capabilities.
