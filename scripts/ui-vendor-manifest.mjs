import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Digest of one vendored artifact — a file, or a whole directory tree.
 *
 * Directories exist in the copy list because the Seti file icons are ~79 SVGs
 * the panel fetches lazily as siblings of `file-panel.js`; listing them
 * individually would be a manifest nobody maintains. A tree is hashed over its
 * sorted relative paths AND contents, so a removed or renamed icon moves the
 * digest exactly as a rewritten one does — an icon that silently disappeared
 * would otherwise pass the gate and 404 on a phone.
 *
 * Files keep the plain content hash they have always had, so adding this did
 * not invalidate a single existing manifest entry.
 */
export function hashPath(target) {
  if (!statSync(target).isDirectory()) {
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  }
  const h = createHash("sha256");
  const walk = (abs, rel) => {
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        walk(join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(abs));
    h.update("\0");
  };
  walk(target, "");
  return h.digest("hex");
}

export const UI_VENDOR_COPIES = [
  ["media/chat.css", "media/chat.css"],
  ["media/chat.js", "media/chat.js"],
  // The shared file panel. One renderer for the desktop's docked tree and the
  // browser client's — the extension injects it into its own document, the
  // relay serves this copy. Vendored for the same reason chat.js is: the
  // extension repo is the single source of truth for the UI.
  ["media/file-panel.css", "media/file-panel.css"],
  ["media/file-panel.js", "media/file-panel.js"],
  // The panel's syntax highlighter. Must be SERVED BEFORE file-panel.js (see
  // web/chat.html) — the panel reads the global at render time and silently
  // falls back to plain text when it is absent.
  ["media/syntax-highlight.js", "media/syntax-highlight.js"],
  // Seti file-type icons, fetched lazily by the panel as siblings of
  // file-panel.js. A directory rather than 79 entries — see hashPath above.
  ["media/file-icons", "media/file-icons"],
  ["media/pcm-worklet.js", "media/pcm-worklet.js"],
  // The settings surface. Served BEFORE chat.js (see web/chat.html) — the
  // gear's "All settings" entry reads its global at click time.
  ["media/settings.css", "media/settings.css"],
  ["media/settings.js", "media/settings.js"],
  ["media/webview-helpers.js", "media/webview-helpers.js"],
  ["media/mathjax/tex-svg-full.js", "media/mathjax/tex-svg-full.js"],
  ["media/mermaid/mermaid.min.js", "media/mermaid/mermaid.min.js"],
  ["resources/grok-icon.svg", "resources/grok-icon.svg"],
];

export const UI_VENDOR_HASH_MANIFEST = "ui-vendor-manifest.json";
export const UI_VENDOR_HASH_MANIFEST_VERSION = 1;
