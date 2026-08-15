// The version the browser client reports as its OWN. It is the extension
// release the vendored UI was cut from — not the relay's package version, which
// has never moved, and not the deploy hash, which nobody can compare against the
// app on their desk. `npm run sync-ui` records it into the vendor manifest.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectWebAppVersion, readWebAppVersion } from "../src/server.js";

describe("readWebAppVersion", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grok-webver-"));
    mkdirSync(join(root, "vendor"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const manifest = (source: unknown) =>
    writeFileSync(
      join(root, "vendor", "ui-vendor-manifest.json"),
      JSON.stringify({ version: 1, source, artifacts: [] }),
    );

  it("reads the vendored UI's source version", () => {
    manifest({ repository: "grok-build-vscode", appVersion: "3.4.0" });
    expect(readWebAppVersion(root, "deadbeef")).toBe("3.4.0");
  });

  it("falls back to the deploy hash when the manifest predates the field", () => {
    // A vendor tree synced before sync-ui recorded the version — the page still
    // has to say something, and the deploy hash is at least unique per deploy.
    manifest({ repository: "grok-build-vscode", revision: "abc" });
    expect(readWebAppVersion(root, "deadbeef")).toBe("deadbeef");
  });

  it("falls back when there is no vendor manifest at all", () => {
    expect(readWebAppVersion(root, "deadbeef")).toBe("deadbeef");
  });

  it("falls back rather than throwing on a corrupt manifest", () => {
    writeFileSync(join(root, "vendor", "ui-vendor-manifest.json"), "{ not json");
    expect(readWebAppVersion(root, "deadbeef")).toBe("deadbeef");
  });
});

describe("injectWebAppVersion", () => {
  it("puts the version in a meta tag the page can read without a fetch", () => {
    const out = injectWebAppVersion("<html><head>\n<title>x</title></head></html>", "3.4.0");
    expect(out).toContain(`<meta name="grok-web-version" content="3.4.0">`);
    expect(out.indexOf("grok-web-version")).toBeLessThan(out.indexOf("<title>"));
  });

  it("strips anything that could break out of the attribute", () => {
    // The value reaches here from a file on disk, so it is not attacker-supplied
    // — but it is interpolated into HTML, and an unquoted surprise in a version
    // string is not a thing to discover in production.
    const out = injectWebAppVersion("<head></head>", `3.4.0" onload="alert(1)`);
    expect(out).toContain(`content="3.4.0onloadalert1"`);
    expect(out).not.toContain("onload=");
  });

  it("leaves a page with no head untouched", () => {
    expect(injectWebAppVersion("<p>fragment</p>", "3.4.0")).toBe("<p>fragment</p>");
  });
});
