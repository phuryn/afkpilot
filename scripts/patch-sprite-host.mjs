/**
 * Put an UNRELEASED desktop host on one cloud machine, so it can be tested
 * before there is a release.
 *
 * A sprite installs its host from `releases/latest`, so host changes normally
 * reach it only by shipping. That makes the last mile of any host change
 * untestable on the surface it matters most for — a machine with nobody at its
 * screen. This closes that gap for a DEV machine.
 *
 * It does not ship 113 MB. The AppImage's payload is already extracted on the
 * machine, and the JS lives in `resources/app.asar`, which contains just
 * `out/`, `media/`, `node_modules/` and `package.json`. So: clone the PUBLIC
 * extension repo onto the machine, build `out/` there, swap `out/` and `media/`
 * into an extracted copy of the archive, repack, restart. Nothing crosses the
 * exec channel but commands.
 *
 * Reversible: the original archive is kept as `app.asar.bak` and `--revert`
 * puts it back.
 *
 * FOR DEV MACHINES. A patched host reports the version it was built from, which
 * is not what `releases/latest` says the machine is running.
 *
 * To keep the patch, this WRITES `.afkpilot-asset` with the currently published
 * AppImage URL, because that is the value the bootstrap's host check compares
 * against. The machine therefore keeps this build until a release NEWER than
 * today's exists, and is then correctly replaced by it. `--revert` puts the
 * original record back so normal updating resumes.
 *
 * Do not be tempted to drop that step on the grounds that the machine looks
 * settled. The bootstrap skips its refresh entirely while a machine is
 * unclaimed, so an unpinned patch looks perfectly stable right up until the
 * moment someone CLAIMS the machine to test on it — which writes the env file,
 * restarts the service, and installs latest over the patch on that first boot.
 *
 *     npm run build
 *     node scripts/patch-sprite-host.mjs --sprite <name> --ref <git-ref>
 *     node scripts/patch-sprite-host.mjs --sprite <name> --revert
 *
 * Token from SPRITES_TOKEN in the environment, or this repo's gitignored .env.
 *
 * Four things cost time the first time this was done by hand, all handled here:
 *
 *  - `asar extract-file` writes a file named after the basename into the CWD.
 *    It does NOT write to stdout, so `... > check.js` silently captures nothing
 *    and every verification passes vacuously. This verifies by sha256 instead.
 *  - The boot script uses `SECONDS`, a bash builtin. Started with `sh` (dash on
 *    this image) it dies at line 13 with "SECONDS: parameter not set" and the
 *    host never comes back.
 *  - Never start the boot script while a host is already running: its last act
 *    is to `exec` the app, so you get a second one beside the live process.
 *    Stop first, then start.
 *  - The machine must be awake for any of this; an exec wakes it.
 */
import { readFileSync } from "node:fs";
import { spriteExec } from "../dist/sprite-exec.js";

const API_BASE = process.env.SPRITES_API_BASE || "https://api.sprites.dev";
const REPO = "https://github.com/phuryn/grok-build-vscode.git";
const APP = "/home/sprite/afkpilot/squashfs-root";
const RES = `${APP}/resources`;
// pool-bootstrap.ts keeps its bookkeeping ONE LEVEL UP, in `$HOME/afkpilot`
// (its own `APP`), not in the extracted image. Writing `.afkpilot-asset` beside
// the app instead creates an inert file the bootstrap never reads, so the patch
// looks pinned and is replaced on the next boot anyway.
const HOME_APP = "/home/sprite/afkpilot";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SPRITE = arg("sprite");
const REF = arg("ref", "main");
const REVERT = process.argv.includes("--revert");

function spritesToken() {
  if (process.env.SPRITES_TOKEN) return process.env.SPRITES_TOKEN.trim();
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/).find((l) => l.startsWith("SPRITES_TOKEN="));
    if (line) return line.slice("SPRITES_TOKEN=".length).trim();
  } catch { /* env var is the supported path */ }
  return "";
}

const token = spritesToken();
if (!SPRITE || !token) {
  console.error(
    "usage: node scripts/patch-sprite-host.mjs --sprite <name> [--ref <git-ref>] [--revert]\n" +
    (token ? "" : "\nNo SPRITES_TOKEN. Set it in the environment or this repo's .env."),
  );
  process.exit(2);
}

const exec = spriteExec({ token, apiBase: API_BASE, timeoutMs: 900_000 });
async function run(label, line, { quiet = false } = {}) {
  const r = await exec(SPRITE, ["sh", "-lc", line]);
  // Always parse a MARKER, never the tail: exec output is framed, so the last
  // token is a control byte rather than a value.
  const out = (r.output || "");
  if (!quiet) {
    // Explicit escapes, never literal control bytes: writing framing bytes
    // straight into the source makes git treat this file as BINARY, and a stray
    // NUL reached a commit in this project exactly that way once.
    const shown = out.replace(/[\u0000-\u001f]/g, "").trim().split("\n").slice(-6).join("\n");
    console.log(`\n=== ${label} ===\n${shown}`);
  }
  if (!r.ok) throw new Error(`${label}: exec failed (${r.error ?? "unknown"})`);
  return out;
}

/**
 * The newest published, non-prerelease AppImage — the same asset
 * `pool-bootstrap.ts` resolves, and the value it compares `.afkpilot-asset`
 * against. Returns "" if the lookup fails; the caller decides what that means.
 */
async function publishedAppImage() {
  try {
    const releases = await (await fetch(
      `https://api.github.com/repos/phuryn/grok-build-vscode/releases?per_page=100`,
    )).json();
    if (!Array.isArray(releases)) return "";
    for (const release of releases) {
      if (!release || release.draft !== false || release.prerelease !== false) continue;
      const asset = (release.assets || []).find((a) =>
        typeof a.browser_download_url === "string" && a.browser_download_url.endsWith(".AppImage"));
      if (asset) return asset.browser_download_url;
    }
  } catch { /* treated as "unknown" below */ }
  return "";
}

if (REVERT) {
  await run("stop the host", `pkill -f '${APP}/grok-build-desktop' 2>/dev/null; sleep 3; echo PROCS=$(ps -eo comm --no-headers | grep -c grok-build-desk)`);
  await run("restore", `test -f ${RES}/app.asar.bak && cp ${RES}/app.asar.bak ${RES}/app.asar && echo RESTORED=$(wc -c < ${RES}/app.asar) || echo NO_BACKUP`);
  // Put back the release the machine really came from, so its next boot
  // resumes normal updating instead of believing it is already current.
  await run("restore the asset record", `test -f ${HOME_APP}/.afkpilot-asset.bak && mv ${HOME_APP}/.afkpilot-asset.bak ${HOME_APP}/.afkpilot-asset && echo ASSET=$(cat ${HOME_APP}/.afkpilot-asset) || echo NO_ASSET_BACKUP`);
  await run("start the host", "setsid nohup bash \"$HOME/afkpilot-boot.sh\" > /dev/null 2>&1 < /dev/null & sleep 5; echo LAUNCHED=ok");
  console.log("\nreverted — give it ~30s, then check the machine.");
  process.exit(0);
}

console.log(`patching ${SPRITE} with grok-build-vscode@${REF}`);

// 1. Back up once. `-n` keeps the ORIGINAL release archive as the restore
//    point even when this script runs several times.
await run("backup", `cp -n ${RES}/app.asar ${RES}/app.asar.bak; echo BAK=$(wc -c < ${RES}/app.asar.bak)`);

// 2. Build on the machine, from the public repo. /tmp, never beside the
//    owner's own checkout — a second working copy where the catalog can see it
//    causes its own confusion.
await run("clone", `rm -rf /tmp/gbv && git clone --quiet ${REPO} /tmp/gbv && cd /tmp/gbv && git checkout --quiet ${REF} && echo HEAD=$(git log --oneline -1)`);
await run("npm install", "cd /tmp/gbv && npm install --no-audit --no-fund --silent >/dev/null 2>&1; echo INSTALL=$?");
await run("compile", "cd /tmp/gbv && npx tsc -p . >/dev/null 2>&1; echo TSC=$?; echo SIDEBAR=$(wc -c < out/sidebar.js)");

// 3. Swap the two directories the host actually is, and repack.
await run("extract", `rm -rf /tmp/appsrc && cd /tmp && npx --yes @electron/asar extract ${RES}/app.asar /tmp/appsrc >/dev/null 2>&1; echo ENTRIES=$(ls /tmp/appsrc | tr '\\n' ' ')`);
await run("swap", "rm -rf /tmp/appsrc/out /tmp/appsrc/media && cp -a /tmp/gbv/out /tmp/gbv/media /tmp/appsrc/ && echo SWAPPED=ok");
await run("pack", "cd /tmp && rm -f /tmp/app.asar.new && npx --yes @electron/asar pack /tmp/appsrc /tmp/app.asar.new >/dev/null 2>&1; echo PACKED=$(wc -c < /tmp/app.asar.new)");

// 4. PROVE the archive carries the build before anything is swapped in.
//    sha256 of the freshly built file against the one read back out of it.
const proof = await run("verify", [
  "cd /tmp && rm -f /tmp/verify && mkdir -p /tmp/verify && cd /tmp/verify",
  "npx --yes @electron/asar extract-file /tmp/app.asar.new out/sidebar.js >/dev/null 2>&1",
  "echo BUILT=$(sha256sum /tmp/gbv/out/sidebar.js | cut -d' ' -f1)",
  "echo PACKED=$(sha256sum /tmp/verify/sidebar.js 2>/dev/null | cut -d' ' -f1)",
].join("; "));
const built = proof.match(/BUILT=([0-9a-f]{64})/)?.[1];
const packed = proof.match(/PACKED=([0-9a-f]{64})/)?.[1];
if (!built || built !== packed) {
  console.error(`\nREFUSING TO SWAP: packed archive does not match the build.\n  built=${built}\n  packed=${packed}`);
  process.exit(1);
}
console.log(`\nverified: packed out/sidebar.js matches the build (${built.slice(0, 12)}…)`);

// 5. Stop, swap, start. In that order — the boot script execs the app, so
//    starting it with one already live gives you two.
await run("stop the host", `pkill -f '${APP}/grok-build-desktop' 2>/dev/null; sleep 4; echo PROCS=$(ps -eo comm --no-headers | grep -c grok-build-desk)`);
await run("install", `cp /tmp/app.asar.new ${RES}/app.asar; echo LIVE=$(wc -c < ${RES}/app.asar)`);

// 5b. Make the patch survive a claim.
//
// The docstring above promises the bootstrap leaves a patch alone until a real
// release supersedes it. That is only true when `.afkpilot-asset` ALREADY names
// `releases/latest`, because `refresh_host_if_stale` short-circuits on a URL
// compare. On a machine that is behind — which every pool machine is, right
// after provisioning — the compare differs and the bootstrap installs latest
// OVER the patch, silently.
//
// It does not bite while the machine is unclaimed, because that function
// returns early with no `~/.afkpilot.env`. It bites on the CLAIM: that writes
// the env file and restarts the service, so the first boot of the machine you
// just took is the one that discards what you patched onto it. The tester then
// exercises a stale host and reports its age as a bug.
//
// So record the URL the bootstrap would fetch. The machine keeps this build
// until a NEWER release than today's exists, which is exactly the promise.
const asset = await publishedAppImage();
if (asset) {
  await run("pin the asset record", [
    `cp -n ${HOME_APP}/.afkpilot-asset ${HOME_APP}/.afkpilot-asset.bak 2>/dev/null`,
    `printf '%s\\n' '${asset}' > ${HOME_APP}/.afkpilot-asset`,
    // Also clear the weekly stamp's opposite risk: report what the bootstrap
    // will actually read, so a wrong path shows up here instead of silently
    // surviving until the next boot throws the patch away.
    `echo ASSET=$(cat ${HOME_APP}/.afkpilot-asset)`,
    `rm -f ${APP}/.afkpilot-asset`,
  ].join("; "));
} else {
  console.log(
    "\n=== pin the asset record ===\nWARNING: could not resolve the published AppImage.\n" +
    "The patch will be replaced by releases/latest when this machine is claimed.",
  );
}
await run("clean up", "rm -rf /tmp/gbv /tmp/appsrc /tmp/app.asar.new /tmp/verify; echo CLEANED=ok");
await run("start the host", "setsid nohup bash \"$HOME/afkpilot-boot.sh\" > /dev/null 2>&1 < /dev/null & sleep 5; echo LAUNCHED=ok");

await new Promise((r) => setTimeout(r, 40_000));
await run("check", [
  "echo PROCS=$(ps -eo comm --no-headers | grep -c grok-build-desk)",
  "tail -3 \"$HOME/afkpilot-boot.log\"",
].join("; "));

console.log(
  `\n${SPRITE} is running grok-build-vscode@${REF}.\n` +
  `Undo with:  node scripts/patch-sprite-host.mjs --sprite ${SPRITE} --revert\n` +
  "A real release replaces this on the machine's next weekly host check, which is correct.",
);
