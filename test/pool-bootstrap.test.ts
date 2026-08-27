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
    // An exec's child dies with its connection, and a 25-minute install held
    // open on a WebSocket is a 25-minute chance for a network to blink. A
    // service survives both, and is restarted on boot — the only reason a
    // machine paused for a week comes back on its own.
    const cmd = poolBuildCommand({
      relayHttpUrl: "https://relay.example",
      name: "afkpilot-pool-abc",
      claimSecret: "s3cret",
    });
    // argv, because that is what the exec channel carries: cmd[0] is the
    // binary and the rest are its arguments, each its own `cmd=` parameter.
    expect(cmd[0]).toBe("sh");
    expect(cmd.join(" ")).toContain("sprite-env services create afkpilot");
    expect(cmd.join(" ")).toContain("--args 'afkpilot-pool-abc,s3cret'");
  });

  it("works for a machine built to order, with no shelf row to report against", () => {
    // The gap that shipped: this path did not exist, so opening a cloud
    // environment while the pool was empty produced a sprite nothing was ever
    // installed on — it came up, sat there, and the picker counted upwards
    // forever because nothing was going to link.
    const cmd = poolBuildCommand({ relayHttpUrl: "https://relay.example" });
    expect(cmd.join(" ")).toContain("sprite-env services create afkpilot");
    expect(cmd.join(" ")).not.toContain("--args");
  });

  it("sets APPDIR before running the extracted AppImage", () => {
    // Without it AppRun looks for its binary at the filesystem root and the
    // host silently never starts. A machine that installs perfectly and then
    // does nothing is the worst shape a failure can take, so this is pinned.
    const i = script.indexOf("export APPDIR=");
    const j = script.indexOf('AppRun" --no-sandbox');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(script).toContain('export APPDIR="$APP/squashfs-root"');
  });

  it("installs all three agent CLIs itself", () => {
    // Fly's image happens to ship claude and codex, and not grok. Relying on
    // that is relying on somebody else's image to keep containing what we need;
    // the day it drops one, machines come up an agent short and the only
    // symptom is a user told to install something on a computer that does not
    // exist.
    expect(script).toContain("https://x.ai/cli/install.sh");
    expect(script).toContain("https://claude.ai/install.sh");
    expect(script).toContain("@openai/codex@latest");
    // Non-fatal, each — two of three is a usable machine — but never silent.
    expect(script).toContain("grok CLI install FAILED");
    expect(script).toContain("agent MISSING:");
  });

  it("keeps the CLIs current, because nobody in a cloud environment installed them", () => {
    // On a desk the person owns updating what they installed. Here nobody did,
    // so left alone they rot until an agent stops working against its own
    // service for reasons the reader cannot see.
    expect(script).toContain("refresh_agents_if_stale");
    // BEFORE the host starts, never while it runs: swapping a CLI binary under
    // a turn in flight breaks a live session, which is worse than being stale.
    const refresh = script.indexOf("refresh_agents_if_stale" + String.fromCharCode(10));
    const start = script.indexOf("starting host");
    expect(refresh).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(refresh);
    // And bounded, so waking a machine you use daily is not a download a day.
    expect(script).toContain("AGENT_MAX_AGE=604800");
  });

  it("waits to be claimed instead of exiting", () => {
    // A pooled machine boots before anyone owns it. Exiting would let the
    // service supervisor treat a healthy spare as a crash loop.
    expect(script).toContain('while [ ! -f "$ENVFILE" ]; do sleep 5; done');
  });
});
