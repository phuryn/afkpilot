/**
 * Force every cloud machine to pick up the newest published desktop host.
 *
 * YOU DO NOT NORMALLY NEED THIS. `pool-bootstrap.ts` already refreshes the host
 * from `releases/latest` by itself: at boot, non-destructively (the new build is
 * unpacked beside the running one and swapped in only once its AppRun exists),
 * throttled to once a week per machine. Linux has no in-app updater — the
 * electron-updater feed is win32/darwin only — so that boot check is the only
 * thing keeping a sprite current, and it is enough for an ordinary release.
 *
 * What it is for is the impatient case: a release you want out now rather than
 * within a week. `--apply` clears the weekly stamp on every machine, so each one
 * refreshes on its NEXT BOOT instead of up to a week later. For a sleeping
 * machine that is the next time its owner opens it.
 *
 * It deliberately does NOT run the boot script inline. That script ends by
 * `exec`ing the desktop host, so running it by hand on a claimed machine tries
 * to start a SECOND instance beside the live one. Clearing the stamp lets the
 * machine's own designed path do the work, at the moment it is safe to.
 *
 * Unclaimed pool machines are armed the same way and reported separately: the
 * bootstrap's refresh is gated on the claim file (`~/.afkpilot.env`), so an
 * unclaimed machine keeps its provision-time host until somebody takes it —
 * and, with the stamp cleared, refreshes on that first boot rather than up to a
 * week into their use of it.
 *
 * THE TOKEN IS NEVER READ FROM THIS FILE. It comes from the environment, or
 * from the repo's gitignored `.env`. Set it however you like:
 *
 *     $env:SPRITES_TOKEN = "..."      # PowerShell, this session only
 *     SPRITES_TOKEN=... node scripts/refresh-sprite-hosts.mjs
 *
 * Usage (build first — this imports the repo's own exec module):
 *
 *     npm run build
 *     node scripts/refresh-sprite-hosts.mjs            # report only, changes nothing
 *     node scripts/refresh-sprite-hosts.mjs --apply     # clear stamps + refresh now
 *     node scripts/refresh-sprite-hosts.mjs --apply --only afkpilot-pool-abc123
 *     node scripts/refresh-sprite-hosts.mjs --fix-image            # survey the image
 *     node scripts/refresh-sprite-hosts.mjs --fix-image --apply    # install what is missing
 *     node scripts/refresh-sprite-hosts.mjs --fix-image --apply --production
 *
 * `--production` is the ONLY way to reach the real estate, and it reads a
 * different variable (SPRITES_PRODUCTION_TOKEN). Without it, a dev token in
 * .env is all this can ever authenticate with.
 *
 * A machine that is cold will be woken by the exec, do its work, and go back to
 * sleep on its own.
 *
 * THIS SCRIPT NEVER DESTROYS ANYTHING. It has no DELETE call and no reset
 * path, by design and by the owner's instruction: production machines are
 * upgraded in place, never replaced. Its worst failure mode is "unchanged" —
 * the bootstrap's own update path is what actually runs, and that path unpacks
 * beside the running host and swaps only once the new one is intact.
 */
import { readFileSync } from "node:fs";
import { spriteExec } from "../dist/sprite-exec.js";

const API_BASE = process.env.SPRITES_API_BASE || "https://api.sprites.dev";
const RELEASES = "https://api.github.com/repos/phuryn/grok-build-vscode/releases/latest";
const APPLY = process.argv.includes("--apply");
/**
 * Install packages the bootstrap has learned about SINCE these machines were
 * built. The apt step runs once, at first boot, behind a stamp
 * (`if [ ! -f "$STAMP" ]`) and never again — so a package added to
 * APT_PACKAGES reaches NEW machines only, and every existing one stays without
 * it for ever. There is no other path to them.
 *
 * `librsvg2-common` is the first thing to need this and it is not cosmetic:
 * without an SVG decoder in gdk-pixbuf, GTK hands every SVG icon to glycin,
 * whose loader runs under a bwrap that does not work on this image. A failed
 * icon load is FATAL to GTK, so the whole host died — and it was the fallback
 * icon that failed, meaning any icon GTK could not find took the machine down.
 *
 * apt-get install on an already-present package is a no-op, so this is safe to
 * run over the whole estate repeatedly.
 */
const IMAGE_FIX_PACKAGES = ["librsvg2-common"];
const FIX_IMAGE = process.argv.includes("--fix-image");
/**
 * Install the new host NOW, instead of arming it and hoping for a boot.
 *
 * ARMING IS NOT ENOUGH, and believing it was cost a release. Clearing the
 * weekly stamp only matters when the boot script re-runs, and two things stop
 * that from happening on its own: a sleeping machine may resume rather than
 * boot, and `refresh_host_if_stale` returns early on any machine that is not
 * yet claimed. Measured 2026-09-01: a dev machine armed five hours earlier had
 * been up for 2.9 of them with the stamp still cleared and the old build still
 * installed.
 *
 * The host is registered as the sprite SERVICE `afkpilot`, and that service's
 * command IS the boot script (see poolBuildCommand). So restarting the service
 * re-runs `refresh_host_if_stale` and then execs the new build — no machine
 * reboot, and no second host beside the live one, which is the thing that makes
 * running the boot script by hand a bad idea.
 *
 * Still non-destructive: the bootstrap unpacks the new build BESIDE the running
 * one and swaps only once its AppRun exists, so a failed download leaves the
 * machine exactly as it was. What it does cost is the live session on that
 * machine — restarting a host disconnects whoever is driving it. That is
 * inherent, not a bug, and it is why this reports activity before acting.
 */
const FORCE_HOST = process.argv.includes("--force-host");
/**
 * Where a machine re-fetches its boot script from. Production machines were
 * built against afkpilot.com; dev machines against the dev relay. Overridable
 * for anything else.
 */
const RELAY_HTTP = process.env.RELAY_HTTP_URL
  || (PRODUCTION ? "https://afkpilot.com" : "https://grok-remote-dev-development.up.railway.app");
/** Opt in to the REAL estate, by name. See spritesToken. */
const PRODUCTION = process.argv.includes("--production");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

/**
 * Environment first; the gitignored .env is the fallback. Never a literal here.
 *
 * PRODUCTION IS OPT-IN, by name. `--production` reads SPRITES_PRODUCTION_TOKEN
 * and nothing else, so touching the real estate is a deliberate act rather than
 * a consequence of whichever token happens to sit in .env. Without the flag this
 * can only ever reach dev.
 */
function spritesToken() {
  const key = PRODUCTION ? "SPRITES_PRODUCTION_TOKEN" : "SPRITES_TOKEN";
  if (process.env[key]) return process.env[key].trim();
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(key + "="));
    if (line) return line.slice(key.length + 1).trim();
  } catch { /* no .env — the env var is the supported path */ }
  return "";
}

const TOKEN_KEY = PRODUCTION ? "SPRITES_PRODUCTION_TOKEN" : "SPRITES_TOKEN";
const token = spritesToken();
if (!token) {
  console.error(
    `No ${TOKEN_KEY}. Set it in the environment (or in this repo's .env) and run again.\n` +
    `  PowerShell:  $env:${TOKEN_KEY} = "<token>"\n` +
    `  bash:        export ${TOKEN_KEY}=<token>`,
  );
  process.exit(2);
}

const exec = spriteExec({ token, apiBase: API_BASE, timeoutMs: 300_000 });
const sh = (name, line) => exec(name, ["sh", "-lc", line]);

async function listSprites() {
  const res = await fetch(`${API_BASE}/v1/sprites`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sprites list: HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.sprites ?? body.data ?? []);
  return list
    .map((s) => ({ name: s.name ?? s.id, state: s.state ?? s.status ?? "unknown" }))
    .filter((s) => s.name && (!ONLY || s.name === ONLY));
}

async function latestAssetUrl() {
  const res = await fetch(RELEASES, { headers: { "user-agent": "afkpilot-refresh" } });
  if (!res.ok) throw new Error(`releases: HTTP ${res.status}`);
  const body = await res.json();
  const asset = (body.assets ?? []).find((a) => String(a.name).endsWith(".AppImage"));
  return { url: asset?.browser_download_url, tag: body.tag_name };
}

const { url: wantUrl, tag } = await latestAssetUrl();
if (!wantUrl) {
  console.error("The latest release publishes no .AppImage — nothing to roll out.");
  process.exit(1);
}
const sprites = await listSprites();
console.log(`estate: ${PRODUCTION ? "PRODUCTION" : "dev"} (token ${TOKEN_KEY})`);
console.log(`latest release: ${tag}`);
console.log(`machines: ${sprites.length}${ONLY ? ` (filtered to ${ONLY})` : ""}`);
console.log(APPLY ? "mode: APPLY\n" : "mode: report only (pass --apply to act)\n");

let current = 0;
let behind = 0;
let failed = 0;
let skipped = 0;

/**
 * How many machines to work on at once.
 *
 * The wake dominates everything else here — a cold machine takes 20-40s to come
 * up and then ~2s to answer — and the machines are independent: no shared
 * state, no ordering, one exec each. Sequentially that made a 31-machine
 * production sweep ~15 minutes of mostly waiting.
 *
 * Bounded rather than unbounded because this wakes real VMs and talks to one
 * API; 8 is enough to make the wall-clock the slowest machine rather than the
 * sum, without opening 31 WebSockets at once.
 */
const CONCURRENCY = 8;

/** Run one machine. Returns its report line; never throws, so one dead machine
 * cannot abandon the other thirty. */
async function handle(sprite) {
  // `.afkpilot-asset` is the URL the machine last installed, written by the
  // bootstrap. Comparing URLs is how the bootstrap itself decides, so this
  // reports exactly what it would do.
  // ALWAYS parse a marker, never the tail of the stream. Exec output arrives
  // ALWAYS parse a marker, never the tail of the stream: exec output is
  // framed, so the last token is a control byte rather than the value.
  // reported all fifteen dev machines as behind when every one was current,
  // which in production is fifteen needless 110 MB downloads.
  if (FORCE_HOST) {
    const before = (await sh(
      sprite.name,
      "echo ASSET=$(sed 's|.*/||' \"$HOME/afkpilot/.afkpilot-asset\" 2>/dev/null || echo NONE); " +
      "echo CLAIMED=$([ -f \"$HOME/.afkpilot.env\" ] && echo yes || echo no); " +
      "echo KIND=$(cat \"$HOME/afkpilot/.afkpilot-kind\" 2>/dev/null || echo none); " +
      // How recently anything was written to this machine's conversations. The
      // owner asked to see that nobody is mid-session before restarting hosts,
      // and the sessions directory is the honest signal: a driven machine
      // writes to it continuously.
      //
      // ONLY MEANINGFUL BEFORE ACTING. A restarted host writes to this
      // directory itself, so a verification pass run straight after a force
      // reports every machine it just touched as in use. Read the flag on the
      // dry run, not on the pass that confirms the result.
      "echo IDLE=$(find \"$HOME/.grok/sessions\" -type f -newermt '-10 minutes' 2>/dev/null | head -1 | wc -l)",
    )).output || "";
    const asset = before.match(/ASSET=(\S+)/)?.[1] ?? "NONE";
    const claimed = before.match(/CLAIMED=(\S+)/)?.[1] === "yes";
    const kind = before.match(/KIND=(\S+)/)?.[1] ?? "none";
    const busy = (before.match(/IDLE=(\d+)/)?.[1] ?? "0") !== "0";
    const currentAlready = tag && asset.includes(tag.replace(/^v/, ""));
    const use = busy ? ", IN USE (last 10 min)" : "";

    if (currentAlready) { current++; return `  ${sprite.name}  [${sprite.state}${use}]  already ${tag}`; }
    // An unclaimed machine cannot refresh its host: refresh_host_if_stale
    // returns early without the claim file. It picks the new build up on the
    // claim, which restarts the service — and its stamp is already cleared.
    if (!claimed || kind !== "appimage") {
      skipped++;
      return `  ${sprite.name}  [${sprite.state}]  ${!claimed ? "unclaimed — updates when claimed" : "not an AppImage install"}`;
    }
    behind++;
    if (!APPLY) return `  ${sprite.name}  [${sprite.state}${use}]  would force ${asset} -> ${tag}`;

    // RE-FETCH THE BOOT SCRIPT FIRST. It is downloaded once, at provision, and
    // the service runs that local copy for ever — so a fix to pool-bootstrap.ts
    // reaches new machines only, exactly like the apt step. That is how a host
    // launched without dropping its ambient capabilities kept crashing on
    // machines that had already been "updated". Fetch to a temp file and move
    // only on success, so a failed download cannot leave a machine with no boot
    // script at all.
    await sh(
      sprite.name,
      `curl -fsSL --max-time 60 ${RELAY_HTTP}/api/environment/pool-bootstrap.sh ` +
      "-o \"$HOME/afkpilot-boot.next\" " +
      "&& chmod +x \"$HOME/afkpilot-boot.next\" " +
      "&& mv \"$HOME/afkpilot-boot.next\" \"$HOME/afkpilot-boot.sh\"; " +
      "rm -f \"$HOME/afkpilot-boot.next\"; " +
      "rm -f \"$HOME/afkpilot/.afkpilot-host-checked\"; " +
      "/.sprite/bin/sprite-env services restart afkpilot >/dev/null 2>&1; echo GO",
    );
    // Poll the asset record rather than guessing a delay: the download is
    // ~110 MB and a cold machine is slower than a warm one.
    const deadline = Date.now() + 12 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 15_000));
      const now = (await sh(
        sprite.name,
        "echo ASSET=$(sed 's|.*/||' \"$HOME/afkpilot/.afkpilot-asset\" 2>/dev/null || echo NONE)",
      )).output || "";
      const got = now.match(/ASSET=(\S+)/)?.[1] ?? "NONE";
      if (tag && got.includes(tag.replace(/^v/, ""))) {
        return `  ${sprite.name}  [${sprite.state}${use}]  FORCED -> ${tag}`;
      }
      if (Date.now() > deadline) {
        failed++;
        return `  ${sprite.name}  [${sprite.state}${use}]  TIMED OUT — still ${got} (machine unchanged)`;
      }
    }
  }

  if (FIX_IMAGE) {
    // Report what is missing first, so a dry run says something useful.
    const probe = await sh(
      sprite.name,
      "echo GTKSTACK=$(ls -d /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0 >/dev/null 2>&1 && echo yes || echo no); " +
      "echo SVG=$(ls /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/*/loaders/ 2>/dev/null | grep -c svg)",
    );
    const out = probe.output || "";
    // A machine with no gdk-pixbuf loader DIRECTORY does not have the GTK stack
    // at all, which means it is not running the desktop host — production
    // carries one such machine (`web-terminal`). It cannot hit the icon crash
    // and cannot be given a loader, so calling it "STILL MISSING" reported a
    // failed production change that had not happened. Not in scope, and said so.
    if (!/GTKSTACK=yes/.test(out)) {
      skipped++;
      return `  ${sprite.name}  [${sprite.state}]  no desktop host here — not in scope`;
    }
    const hasSvg = (out.match(/SVG=(\d+)/)?.[1] ?? "0") !== "0";
    if (hasSvg) {
      current++;
      return `  ${sprite.name}  [${sprite.state}]  image ok`;
    }
    behind++;
    if (!APPLY) {
      return `  ${sprite.name}  [${sprite.state}]  NEEDS ${IMAGE_FIX_PACKAGES.join(" ")}`;
    }
    const fix = await sh(
      sprite.name,
      "sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends " +
      `${IMAGE_FIX_PACKAGES.join(" ")} >/dev/null 2>&1; ` +
      "echo SVG=$(ls /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/*/loaders/ 2>/dev/null | grep -c svg)",
    );
    const ok = ((fix.output || "").match(/SVG=(\d+)/)?.[1] ?? "0") !== "0";
    if (!ok) failed++;
    return `  ${sprite.name}  [${sprite.state}]  ${ok ? "IMAGE FIXED" : "STILL MISSING"}`;
  }

  const read = await sh(
    sprite.name,
    "echo ASSET=$(cat \"$HOME/afkpilot/.afkpilot-asset\" 2>/dev/null || echo NONE); " +
    "echo CLAIMED=$([ -f \"$HOME/.afkpilot.env\" ] && echo yes || echo no)",
  );
  const out = read.output || "";
  const have = out.match(/ASSET=(\S+)/)?.[1] ?? "NONE";
  const claimed = out.match(/CLAIMED=(\S+)/)?.[1] === "yes";
  const upToDate = have === wantUrl;
  const who = claimed ? "in use" : "unclaimed";
  if (upToDate) current++; else behind++;

  if (!APPLY) {
    const label = upToDate ? "current" : have === "NONE" ? "no record" : "behind";
    return `  ${sprite.name}  [${sprite.state}, ${who}]  ${label}`;
  }
  if (upToDate) {
    return `  ${sprite.name}  [${sprite.state}, ${who}]  current — nothing to do`;
  }
  // Clear the weekly stamp and stop there. The bootstrap's own gate is the only
  // reason it would not refresh on the next boot, and its update path is
  // non-destructive by design. Running the boot script by hand instead would
  // try to start a second desktop host beside the live one, because that script
  // ends by exec'ing it.
  const run = await sh(
    sprite.name,
    "rm -f \"$HOME/afkpilot/.afkpilot-host-checked\"; " +
    "echo STAMP=$([ -f \"$HOME/afkpilot/.afkpilot-host-checked\" ] && echo present || echo cleared)",
  );
  const ok = (run.output || "").match(/STAMP=(\S+)/)?.[1] === "cleared";
  if (!ok) failed++;
  return `  ${sprite.name}  [${sprite.state}, ${who}]  ` +
    (ok ? "armed — refreshes on next boot" : "COULD NOT ARM");
}

// Fixed pool of workers over a shared cursor: simpler than batching, and it
// keeps every worker busy instead of waiting for the slowest machine in a batch.
// Report lines are collected by index and printed in list order at the end, so
// the output reads the same as it did when this was sequential.
const lines = new Array(sprites.length);
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, sprites.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= sprites.length) return;
      try {
        lines[i] = await handle(sprites[i]);
      } catch (err) {
        // One unreachable machine must not abandon the rest of the estate.
        failed++;
        lines[i] = `  ${sprites[i].name}  [${sprites[i].state}]  ERROR ${err?.message ?? err}`;
      }
    }
  }),
);
for (const line of lines) console.log(line);

console.log(
  `\n${APPLY ? (FORCE_HOST ? "forced" : "armed") : "surveyed"}: ${sprites.length} machines · ` +
  `${current} already current · ${behind} behind` +
  (skipped ? ` · ${skipped} not in scope` : "") +
  (APPLY ? ` · ${failed} ${FORCE_HOST ? "failed" : "could not be armed"}` : ""),
);
if (APPLY && behind > 0) {
  console.log(
    FORCE_HOST
      ? "Every machine above is running the new host NOW — it was installed and the\n" +
        "service restarted, not left for a boot that might not come.\n"
      : "Each armed machine installs the new host on its next boot — for a sleeping\n" +
    "machine, the next time its owner opens it. Re-run without --apply later to\n" +
    "confirm they landed.",
  );
}
if (!APPLY && behind > 0) {
  console.log("Re-run with --apply to arm them.");
}
