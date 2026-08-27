/**
 * The generated install script.
 *
 * This file exists because a shell script built by a JavaScript template
 * literal has two ways to be wrong that NOTHING else here catches:
 *
 *  1. It can stop being valid JavaScript in a way that still compiles. A
 *     comment containing backticks terminated the template mid-script and the
 *     failure surfaced as `ReferenceError: linux is not defined` at runtime,
 *     from a file that had built cleanly.
 *  2. It can be perfect JavaScript and broken shell. Nothing type-checks a
 *     string.
 *
 * And one way to be wrong that is worse than either, because it looks like
 * success: matching no published artifact, falling silently through to the
 * 25-minute source build, and producing working machines slowly forever.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolBootstrapScript, poolBuildCommand } from "../src/pool-bootstrap";

const script = poolBootstrapScript({ relayHttpUrl: "https://relay.example/" });

/** The name electron-builder actually produced for v3.19.0. Not a guess. */
const REAL_APPIMAGE = "Grok-Build-Desktop-3.19.0-linux-x86_64.AppImage";

describe("it is a shell script", () => {
  it("parses as one", (ctx) => {
    // `bash -n` is the only thing here that reads the script the way a sprite
    // will. Where bash is genuinely absent this SKIPS rather than returns
    // quietly — an early `return` reports green, and a check that reports green
    // without running is worse than not having it: the first version of this
    // test did exactly that and passed while the script was broken.
    let bash: string;
    try {
      execFileSync("bash", ["--version"], { stdio: "ignore" });
      bash = "bash";
    } catch {
      ctx.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "boot-"));
    const path = join(dir, "boot.sh");
    try {
      writeFileSync(path, script);
      execFileSync(bash, ["-n", path], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survived the template literal intact", () => {
    // The exact failure: a stray backtick ends the template and whatever
    // follows becomes JavaScript. If that happens again the script is missing
    // its tail, so check both ends are present.
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("exec node scripts/run-desktop.cjs");
    expect(script).not.toContain("undefined");
  });
});

describe("finding the published build", () => {
  /** The script's own asset pattern, lifted out and applied here. */
  function assetUrlFrom(apiJson: string): string | null {
    const m = /"browser_download_url": *"([^"]*\.AppImage)"/.exec(apiJson);
    return m ? m[1] : null;
  }

  it("matches the name electron-builder really produces", () => {
    // THE ONE THAT WAS WRONG. Every other target is `-x64`; AppImage alone is
    // `-x86_64`, so a pattern built by analogy matched nothing — and matching
    // nothing is not an error here, it is a silent 25-minute fallback.
    const json = `{"assets":[{"browser_download_url": "https://example/${REAL_APPIMAGE}"}]}`;
    expect(assetUrlFrom(json)).toBe(`https://example/${REAL_APPIMAGE}`);
    // And the script must carry that same extension-only pattern, not an
    // architecture string that will drift again.
    expect(script).toContain('[^"]*\\.AppImage"');
    expect(script).not.toContain("linux-x64\\.AppImage");
  });

  it("finds nothing in a release that has none, so the fallback runs", () => {
    const json = `{"assets":[{"browser_download_url": "https://example/App-3.19.0-win-x64.exe"}]}`;
    expect(assetUrlFrom(json)).toBeNull();
    expect(script).toContain("no published build; building from source");
  });

  it("keeps the fallback able to produce a working machine", () => {
    // npm ci can report success and still leave a broken Electron; the first
    // sign is a stack trace at startup, 25 minutes in.
    expect(script).toContain("node node_modules/electron/install.js");
  });
});

describe("what it is told, and what it is not", () => {
  it("carries no secrets", () => {
    // It is fetched by a machine that has proved nothing yet. Anything secret
    // in here would be secret to nobody.
    expect(script).not.toMatch(/sk-device-|SPRITES_TOKEN|SUPABASE|authorization:/i);
  });

  it("is told where home is, exactly once", () => {
    expect(script).toContain('RELAY="https://relay.example"');
    expect(script).not.toContain("relay.example//");
  });

  it("registers a service rather than running the install itself", () => {
    // exec is fire and forget and its child has no supervisor. A service is
    // restarted on boot, which is the only reason a machine paused for a week
    // comes back on its own.
    const cmd = poolBuildCommand({
      relayHttpUrl: "https://relay.example",
      name: "afkpilot-pool-abc",
      claimSecret: "s3cret",
    });
    expect(cmd.args.join(" ")).toContain("sprite-env services create afkpilot");
    expect(cmd.args.join(" ")).toContain("--args 'afkpilot-pool-abc,s3cret'");
  });

  it("waits to be claimed instead of exiting", () => {
    // A pooled machine boots before anyone owns it. Exiting would let the
    // service supervisor treat a healthy spare as a crash loop.
    expect(script).toContain('while [ ! -f "$ENVFILE" ]; do sleep 5; done');
  });
});
