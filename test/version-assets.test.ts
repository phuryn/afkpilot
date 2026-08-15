// versionAssets — the cache-buster that stamps `?v=<deploy>` onto the vendored
// asset refs in a served HTML page. It exists because Cloudflare's Browser
// Cache TTL rewrites our origin `no-cache` to hours on static .js/.css, so a UI
// deploy silently kept serving the old bundle; a changing URL is what forces the
// refetch. These tests pin exactly what gets rewritten and what is left alone.
import { describe, it, expect } from "vitest";
import { versionAssets } from "../src/server.js";

describe("versionAssets", () => {
  it("stamps ?v= onto vendored UI + auth.js/device-display.js/theme.css/host-version.js script and link refs", () => {
    const html = [
      `<link rel="stylesheet" href="/vendor/media/chat.css" />`,
      `<script src="/vendor/media/chat.js"></script>`,
      `<script src="/vendor/media/webview-helpers.js"></script>`,
      `<script src="/auth.js"></script>`,
      `<script src="/device-display.js"></script>`,
      `<script src="/host-version.js"></script>`,
      `<link rel="stylesheet" href="/theme.css">`,
    ].join("\n");
    const out = versionAssets(html, "abc123");
    expect(out).toContain(`href="/vendor/media/chat.css?v=abc123"`);
    expect(out).toContain(`src="/vendor/media/chat.js?v=abc123"`);
    expect(out).toContain(`src="/vendor/media/webview-helpers.js?v=abc123"`);
    expect(out).toContain(`src="/auth.js?v=abc123"`);
    expect(out).toContain(`src="/device-display.js?v=abc123"`);
    expect(out).toContain(`src="/host-version.js?v=abc123"`);
    expect(out).toContain(`href="/theme.css?v=abc123"`);
  });

  it("leaves page links, images, manifest, and cross-origin refs untouched", () => {
    const html = [
      `<a href="/">home</a>`,
      `<a href="/link">link</a>`,
      `<link rel="icon" href="/favicon.svg" />`,
      `<link rel="manifest" href="/manifest.webmanifest" />`,
      `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
      `<script src="https://cdn.example.com/x.js"></script>`,
    ].join("\n");
    expect(versionAssets(html, "abc123")).toBe(html);
  });

  it("does not double-stamp a ref that already carries a query", () => {
    const html = `<script src="/vendor/media/chat.js?v=old"></script>`;
    // The [^"?]+ target class refuses to match past an existing '?', so a
    // re-run is a no-op rather than piling on a second ?v=.
    expect(versionAssets(html, "new")).toBe(html);
  });
});
