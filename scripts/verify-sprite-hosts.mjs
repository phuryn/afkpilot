/**
 * Read the estate back after a rollout, and believe only what the machines say.
 *
 * `refresh-sprite-hosts.mjs --force-host` reports FORCED on an observation: the
 * asset record names the new tag and a host process is up. That is not proof
 * that the RUNNING process is the new build, and the script says so itself.
 * This closes the gap from the other side — it greps the unpacked bundle for a
 * string that exists only in the release being rolled out, so a machine that
 * kept an older renderer cannot report as current.
 *
 * Read-only: no restart, no write, no delete. It does wake a sleeping machine,
 * which is the same cost as any other exec and lasts a second.
 *
 *     node scripts/verify-sprite-hosts.mjs --production --marker "<string>"
 *     node scripts/verify-sprite-hosts.mjs --production --marker "<string>" --only <name>
 */
import { readFileSync } from "node:fs";
import { spriteExec } from "../dist/sprite-exec.js";

const API_BASE = process.env.SPRITES_API_BASE || "https://api.sprites.dev";
const PRODUCTION = process.argv.includes("--production");
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ONLY = argOf("--only");
const MARKER = argOf("--marker");
const WANT = argOf("--tag");
const CONCURRENCY = 8;

const TOKEN_KEY = PRODUCTION ? "SPRITES_PRODUCTION_TOKEN" : "SPRITES_TOKEN";
function spritesToken() {
  if (process.env[TOKEN_KEY]) return process.env[TOKEN_KEY].trim();
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/).find((l) => l.startsWith(TOKEN_KEY + "="));
    if (line) return line.slice(TOKEN_KEY.length + 1).trim();
  } catch { /* env var is the supported path */ }
  return "";
}
const token = spritesToken();
if (!token) { console.error(`No ${TOKEN_KEY}.`); process.exit(2); }
if (!MARKER) { console.error("Pass --marker \"<string present only in the new build>\"."); process.exit(2); }

const exec = spriteExec({ token, apiBase: API_BASE, timeoutMs: 300_000 });
const sh = (name, line) => exec(name, ["sh", "-lc", line]);

const res = await fetch(`${API_BASE}/v1/sprites`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`sprites list: HTTP ${res.status}`); process.exit(1); }
const body = await res.json();
const sprites = (Array.isArray(body) ? body : (body.sprites ?? body.data ?? []))
  .map((s) => ({ name: s.name ?? s.id, state: s.state ?? s.status ?? "unknown" }))
  .filter((s) => s.name && (!ONLY || s.name === ONLY));

console.log(`estate: ${PRODUCTION ? "PRODUCTION" : "dev"} · machines: ${sprites.length}`);
console.log(`marker: ${MARKER}${WANT ? ` · expecting ${WANT}` : ""}\n`);

let ok = 0, stale = 0, unknown = 0;
const lines = new Array(sprites.length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sprites.length) }, async () => {
  for (;;) {
    const i = cursor++;
    if (i >= sprites.length) return;
    const s = sprites[i];
    try {
      const out = (await sh(s.name,
        "A=\"$HOME/afkpilot\"; " +
        "echo ASSET=$(sed 's|.*/||' \"$A/.afkpilot-asset\" 2>/dev/null || echo NONE); " +
        "echo UP=$(pgrep -c -f 'grok-build-desktop --no-sandbox'); " +
        `echo MARK=$(grep -rlas -- ${JSON.stringify(MARKER)} "$A/squashfs-root/resources" 2>/dev/null | wc -l)`,
      )).output || "";
      const asset = out.match(/ASSET=(\S+)/)?.[1] ?? "NONE";
      const up = (out.match(/UP=(\d+)/)?.[1] ?? "0") !== "0";
      const mark = Number(out.match(/MARK=(\d+)/)?.[1] ?? "0");
      const tagOk = !WANT || asset.includes(WANT.replace(/^v/, ""));
      if (mark > 0 && tagOk && up) { ok++; lines[i] = `  ${s.name}  [${s.state}]  CURRENT — ${asset}, marker in ${mark} file(s), host up`; }
      else if (mark > 0 && tagOk) { ok++; lines[i] = `  ${s.name}  [${s.state}]  bundle current — ${asset}, marker present; no host process right now`; }
      else { stale++; lines[i] = `  ${s.name}  [${s.state}]  STALE — asset ${asset}, marker ${mark}, host ${up ? "up" : "down"}`; }
    } catch (err) {
      unknown++;
      lines[i] = `  ${s.name}  [${s.state}]  UNKNOWN — ${err?.message ?? err}`;
    }
  }
}));
for (const line of lines) console.log(line);
console.log(`\nverified: ${sprites.length} machines · ${ok} carry the new renderer · ${stale} stale · ${unknown} not observed`);
process.exit(stale || unknown ? 1 : 0);
