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
    expect(script).toContain("exec $DROP_CAPS node scripts/run-desktop.cjs");
  });

  /**
   * The host must not hand its ambient capabilities to the things it spawns.
   *
   * bwrap refuses to start while holding unexpected capabilities, glycin runs
   * its SVG loader inside bwrap, and GTK treats a failed icon load as a FATAL
   * assertion — so a missing icon killed a production machine on 2026-09-01.
   * Measured: glycin's own bwrap line fails plainly and succeeds under setpriv.
   *
   * Pinned because the fix is one word in a shell line and would be silently
   * lost by anyone tidying the exec, with the failure appearing hours later on
   * a machine nobody is watching.
   */
  it("starts the host with its inheritable and ambient capabilities dropped", () => {
    const script = poolBootstrapScript({ relayHttpUrl: "https://relay.example" });

    expect(script).toContain("setpriv --inh-caps=-all --ambient-caps=-all");
    // Both launch paths, not just the AppImage one.
    expect(script).toContain('exec $DROP_CAPS "$APPDIR/AppRun" --no-sandbox');
    expect(script).toContain("exec $DROP_CAPS node scripts/run-desktop.cjs");
    // Absent setpriv the host must still start, unwrapped, rather than not at all.
    expect(script).toContain('DROP_CAPS=""');
    expect(script).toContain("command -v setpriv");
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

  it("survives a slow or stalled download instead of hanging until the sweep", () => {
    // Measured 2026-08-27: the filler started ten machines at once, all asking
    // GitHub for the same 110 MB file in the same second. Five stuck
    // mid-download and were marked failed an hour later — neither working nor
    // failing, just occupying a slot.
    expect(script).toContain("--retry 4");
    expect(script).toContain("--continue-at -");        // resume, not restart
    expect(script).toContain("--speed-limit 51200");    // stalled => retry
    expect(script).toContain("--max-time 900");         // a ceiling, always
    // And spread the herd, so they are not all asking at once to begin with.
    expect(script).toMatch(/sleep \$\(\( \(RANDOM % 25\) \+ 1 \)\)/);
  });

  it("discards a download that did not unpack, rather than reporting ready", () => {
    // A truncated file extracts to nothing. Reporting ready then hands somebody
    // a machine that installed cleanly and cannot start.
    expect(script).toContain("did not unpack");
    expect(script).toContain('[ -x "$APP/squashfs-root/AppRun" ]');
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

describe("updating the host on a machine nobody can walk up to", () => {
  /**
   * `refresh_host_if_stale` is the one function here that can destroy a working
   * machine, so it is RUN rather than read. The script's own function is
   * extracted and executed against stub `curl`/`step` and a fake $APP tree —
   * asserting on the tree that is left behind, which is the thing that decides
   * whether somebody's environment still starts tomorrow.
   */
  function bashOr(ctx: { skip(): void }): string | null {
    try {
      execFileSync("bash", ["--version"], { stdio: "ignore" });
      return "bash";
    } catch {
      ctx.skip();
      return null;
    }
  }

  /**
   * Run the function in isolation.
   *
   * `curlBehaviour` is the body of a stub `curl`, which stands in for both the
   * release lookup and the download. Returns the resulting `$APP` listing plus
   * the log the script wrote.
   */
  function runRefresh(bash: string, opts: {
    curlBehaviour: string;
    installedAsset?: string;
    unpacks?: boolean;
    lastChecked?: string;
    /** A download left behind by an earlier attempt, and what it came from. */
    partial?: { asset: string; bytes: string };
  }) {
    const dir = mkdtempSync(join(tmpdir(), "afkpilot-refresh-"));
    try {
      // Everything from the function definition to its closing brace.
      const start = script.indexOf("refresh_host_if_stale() {");
      expect(start).toBeGreaterThan(-1);
      const end = script.indexOf("\n}\n", start);
      const fn = script.slice(start, end + 3);

      const harness = [
        "#!/usr/bin/env bash",
        "set -u",
        `APP="${dir.split(String.fromCharCode(92)).join("/")}/afkpilot"`,
        `ENVFILE="${dir.split(String.fromCharCode(92)).join("/")}/env"`,
        "AGENT_MAX_AGE=604800",
        'HOST_STAMP="$APP/.afkpilot-host-checked"',
        'ASSET_RECORD="$APP/.afkpilot-asset"',
        'step() { echo "$*" >> "$APP/log"; }',
        // The existing, working installation.
        'mkdir -p "$APP/squashfs-root"',
        'printf "#!/bin/sh\necho old\n" > "$APP/squashfs-root/AppRun"',
        'chmod +x "$APP/squashfs-root/AppRun"',
        'echo appimage > "$APP/.afkpilot-kind"',
        'touch "$ENVFILE"',
        `printf '%s\n' "${opts.installedAsset ?? "https://old.example/a-1.0.0-linux-x86_64.AppImage"}" > "$ASSET_RECORD"`,
        `echo "${opts.lastChecked ?? "0"}" > "$HOST_STAMP"`,
        // Stubs. `curl` covers both the API lookup and the download; the
        // downloaded "AppImage" is a script whose --appimage-extract either
        // produces a working squashfs-root or does not.
        "curl() {",
        opts.curlBehaviour,
        "}",
        ...(opts.partial ? [
          'mkdir -p "$APP/next"',
          `printf '%s' "${opts.partial.bytes}" > "$APP/next/afkpilot.AppImage"`,
          `printf '%s\n' "${opts.partial.asset}" > "$APP/next/.asset"`,
        ] : []),
        fn,
        "refresh_host_if_stale",
        '[ -f "$HOST_STAMP" ] || echo STAMP-GONE',
        'ls "$APP" | sort | sed "s/^/APP: /"',
        'echo "APPRUN: $(cat "$APP/squashfs-root/AppRun" 2>/dev/null | tail -1)"',
        'echo "ASSET: $(cat "$ASSET_RECORD" 2>/dev/null)"',
        'echo "LOG: $(cat "$APP/log" 2>/dev/null | tr "\n" ";")"',
      ].join("\n");

      const path = join(dir, "harness.sh");
      writeFileSync(path, harness);
      return execFileSync(bash, [path], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A curl stub that serves a release URL and then a working AppImage. */
  /** The release-lookup half, shared by every curl stub below. */
  const curlLookup = [
    '  local out="" prev=""',
    '  for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
    '  if [ -z "$out" ]; then',
    '    echo \'"browser_download_url": "https://new.example/a-9.9.9-linux-x86_64.AppImage"\'',
    "    return 0",
    "  fi",
  ];

  /** Serves a release URL, then an AppImage that does or does not unpack. */
  const workingCurl = (unpacks: boolean) => [
    ...curlLookup,
    '  printf "#!/bin/sh\nmkdir -p squashfs-root && printf \'#!/bin/sh\\necho new\\n\' > squashfs-root/AppRun && chmod +x squashfs-root/AppRun\n" > "$out"',
    unpacks ? "  return 0" : '  printf "#!/bin/sh\nexit 1\n" > "$out"; return 0',
  ].join(String.fromCharCode(10));

  /** Serves a release URL, then fails the download with curl exit 28. */
  const timingOutCurl = () => [...curlLookup, "  return 28"].join(String.fromCharCode(10));

  it("installs a newer build and keeps the machine startable", (ctx) => {
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, { curlBehaviour: workingCurl(true) });
    expect(out).toContain("APPRUN: echo new");
    expect(out).toContain("ASSET: https://new.example/a-9.9.9-linux-x86_64.AppImage");
    expect(out).toContain("host update: installed");
    // No debris left where the next refresh would trip over it.
    expect(out).not.toContain("APP: next");
    expect(out).not.toContain("APP: squashfs-root.old");
  });

  it("KEEPS the old build when the download fails", (ctx) => {
    // The property that matters. A machine a week behind is a nuisance; a
    // machine that deleted its own host is one somebody has lost, and nobody
    // can walk up to it and fix that.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: [
        '  local out="" prev=""',
        '  for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
        '  if [ -z "$out" ]; then',
        '    echo \'"browser_download_url": "https://new.example/a-9.9.9-linux-x86_64.AppImage"\'',
        "    return 0",
        "  fi",
        "  return 22",
      ].join("\n"),
    });
    expect(out).toContain("APPRUN: echo old");
    expect(out).toContain("host update: download unfinished");
    // The partial is KEPT on purpose — it is what the next attempt resumes
    // from. Deleting it is how a slow link never finished updating at all.
    expect(out).toContain("APP: next");
  });

  it("KEEPS the old build when the new one will not unpack", (ctx) => {
    // A truncated download extracts to nothing, and swapping that in would
    // leave an AppRun that does not exist.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, { curlBehaviour: workingCurl(false) });
    expect(out).toContain("APPRUN: echo old");
    expect(out).toContain("host update: did not unpack");
    expect(out).not.toContain("APP: next");
  });

  it("does nothing when the published build is the one already installed", (ctx) => {
    // Otherwise every machine re-downloads 110 MB a week to arrive where it is.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: workingCurl(true),
      installedAsset: "https://new.example/a-9.9.9-linux-x86_64.AppImage",
    });
    expect(out).toContain("APPRUN: echo old");
    expect(out).not.toContain("host update: fetching");
  });

  it("starts over when the partial came from a DIFFERENT build", (ctx) => {
    // The resume flag takes its offset from the file on disk and skips that
    // many bytes of whatever URL comes next — it never checks they are the same
    // artifact. A timed-out release followed a week later by a new one would
    // otherwise append the tail of B onto the head of A: a hybrid treated as
    // finished, failing to unpack, deleted, and not retried for another week.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: workingCurl(true),
      partial: { asset: "https://old.example/a-1.0.0-linux-x86_64.AppImage", bytes: "HEAD-OF-A" },
    });
    expect(out).toContain("partial belongs to a different build; starting over");
    expect(out).toContain("host update: installed");
    expect(out).toContain("APPRUN: echo new");
  });

  it("keeps a partial that belongs to the build it is fetching", (ctx) => {
    // Otherwise a slow link restarts from zero every week and never finishes.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: workingCurl(true),
      partial: { asset: "https://new.example/a-9.9.9-linux-x86_64.AppImage", bytes: "HEAD-OF-SAME" },
    });
    expect(out).not.toContain("starting over");
  });

  it("does not spend the weekly budget on an unfinished download", (ctx) => {
    // A half file plus a written stamp is how a slow link never updates: it
    // waits a week, resumes for two minutes, times out, and waits again.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: timingOutCurl(),
    });
    expect(out).toContain("will resume next boot");
    expect(out).toContain("STAMP-GONE");
  });

  it("does nothing when it checked recently", (ctx) => {
    // Waking a machine you use daily must not be a download every time.
    const bash = bashOr(ctx);
    if (!bash) return;
    const out = runRefresh(bash, {
      curlBehaviour: workingCurl(true),
      lastChecked: String(Math.floor(Date.now() / 1000)),
    });
    expect(out).toContain("APPRUN: echo old");
    // Not even the release lookup: the age check comes first, so a daily wake
    // costs nothing at all.
    expect(out).not.toContain("host update:");
  });
});

describe("the script does not fetch code from the relay to run", () => {
  it("never re-fetches and re-execs itself", () => {
    // A version of this script did, on every boot. That handed a compromised
    // relay arbitrary code on every cloud machine for ever, with the workspace
    // and the device token in reach — the exact thing docs/security.md promises
    // cannot happen, and a syntax check proves nothing about authenticity.
    //
    // A change here reaches existing machines by REBUILDING the shelf, which is
    // a routine operation: ten machines in 139 seconds, measured 2026-08-28.
    expect(script).not.toContain("AFKPILOT_BOOT_REFRESHED");
    // The only executable it pulls is the published build, from GitHub.
    const fetches = script.split(String.fromCharCode(10)).filter((l) => l.includes("curl "));
    const fromRelay = fetches.filter((c) => c.includes("$RELAY"));
    for (const c of fromRelay) {
      expect(c).toContain("/api/environment/");
      expect(c).not.toContain("pool-bootstrap.sh");
    }
  });

  it("bounds the host download to ONE attempt and keeps what it got", () => {
    // max-time is per attempt and resets on every retry, so retries turned a
    // "three minute" bound into a quarter of an hour with the host down — and
    // curl restarts a retry from the original offset after a transfer timeout,
    // so those attempts also discarded the progress they had made.
    const refresh = script.slice(script.indexOf("refresh_host_if_stale() {"));
    const download = refresh.slice(refresh.indexOf("curl -fL"));
    expect(download).toContain("--retry 0");
    expect(download).toContain("--continue-at -");
    expect(download).toContain("--max-time 120");
  });
});
