// Update-feed check for /update/win/latest.yml and /update/mac/latest-mac.yml.
//
// The failure this exists to catch is silent by construction: electron-updater
// treats any bad body as "no update", so a vsix-only latest, a one-arch mac
// yml, or an HTML 200 would stall or confuse installs without anyone noticing.
// GitHub is stubbed — this never depends on the network, a release existing,
// or the anonymous rate limit. Run: npm run e2e:downloads
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LinkStore } from "../dist/link-store.js";
import { InMemoryDeviceRegistry } from "../dist/devices.js";
import { MockSessionVerifier } from "../dist/auth.js";
import { Hub } from "../dist/hub.js";
import { createRelayServer } from "../dist/server.js";
import { UPDATE_FEED_MAX_CANDIDATES } from "../dist/update-feed.js";

const log = (m) => console.log(`[update-feed] ${m}`);
const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const SHA_WIN = "WinSha512Value0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV==";
const SHA_ARM = "ArmSha512Value0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV==";
const SHA_X64 = "X64Sha512Value0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV==";
const GH = "https://github.com/phuryn/grok-build-vscode/releases/download";

const winYml = (v) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-win-x64.exe`,
    `    sha512: ${SHA_WIN}`,
    "    size: 84167424",
    `path: Grok-Build-Desktop-${v}-win-x64.exe`,
    `sha512: ${SHA_WIN}`,
    "releaseDate: '2026-08-13T13:01:24.000Z'",
    "",
  ].join("\n");

const macYml = (v) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `    sha512: ${SHA_ARM}`,
    "    size: 97735494",
    `  - url: Grok-Build-Desktop-${v}-mac-x64.zip`,
    `    sha512: ${SHA_X64}`,
    "    size: 104268091",
    `path: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `sha512: ${SHA_ARM}`,
    "releaseDate: '2026-08-13T13:04:06.000Z'",
    "",
  ].join("\n");

const macOneArchYml = (v) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `    sha512: ${SHA_ARM}`,
    "    size: 1",
    `path: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `sha512: ${SHA_ARM}`,
    "releaseDate: '2026-08-14T00:00:00.000Z'",
    "",
  ].join("\n");

const asset = (tag, name) => ({
  name,
  size: 1,
  browser_download_url: `${GH}/${tag}/${name}`,
});

const desktopRelease = (v, ymls = { win: true, mac: true }) => {
  const tag = `v${v}`;
  const assets = [
    asset(tag, `Grok-Build-Desktop-${v}-win-x64.exe`),
    asset(tag, `Grok-Build-Desktop-${v}-win-x64.exe.blockmap`),
    asset(tag, `Grok-Build-Desktop-${v}-mac-arm64.zip`),
    asset(tag, `Grok-Build-Desktop-${v}-mac-x64.zip`),
    asset(tag, `Grok-Build-Desktop-${v}-mac-arm64.dmg`),
    asset(tag, `Grok-Build-Desktop-${v}-mac-x64.dmg`),
    asset(tag, `grok-vscode-phuryn-${v}.vsix`),
  ];
  if (ymls.win) assets.push(asset(tag, "latest.yml"));
  if (ymls.mac) assets.push(asset(tag, "latest-mac.yml"));
  return { tag_name: tag, draft: false, assets };
};

const vsixOnly = (v) => ({
  tag_name: `v${v}`,
  draft: false,
  assets: [asset(`v${v}`, `grok-vscode-phuryn-${v}.vsix`)],
});

function hrefOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return String(input?.url ?? input);
}

function stubGithub({ releases, ymls, fail = false, failYml = false, ymlStatus = {}, ymlHeaders = {} }) {
  return async (input) => {
    const href = hrefOf(input);
    if (fail) return new Response("nope", { status: 503 });
    if (href.includes("api.github.com") && href.includes("/releases")) {
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (failYml) return new Response("nope", { status: 503 });
    const m = /\/releases\/download\/(v[^/]+)\/(latest(?:-mac)?\.yml)$/.exec(href);
    if (m) {
      const key = `${m[1]}:${m[2]}`;
      const status = ymlStatus[key];
      if (status && status !== 200) {
        return new Response(status === 410 ? "gone" : "missing", { status });
      }
      const body = ymls[key];
      if (body == null) return new Response("missing", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-yaml", ...ymlHeaders[key] },
      });
    }
    return new Response("unexpected " + href, { status: 500 });
  };
}

async function withRelay(githubFetch, ttlMs, fn, { failBackoffMs = 10 } = {}) {
  let n = 0;
  const relay = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot,
    store: new LinkStore({ now: Date.now, randomCode: () => "AAAAAAAA" }),
    devices: new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid-${++n}`,
      randomBytes: (size) => randomBytes(size),
      randomId: () => `dev-${++n}`,
    }),
    sessions: new MockSessionVerifier(true),
    requiredFeature: undefined,
    hub: new Hub(),
    log: () => {},
    pingIntervalMs: 0,
    githubFetch,
    releasesTtlMs: ttlMs,
    feedFailBackoffMs: failBackoffMs,
  });
  await new Promise((r) => relay.server.once("listening", () => r()));
  const base = `http://127.0.0.1:${relay.port()}`;
  try {
    await fn(base);
  } finally {
    await relay.close();
  }
}

function isYmlDownload(href) {
  return /\/releases\/download\/v[^/]+\/latest(?:-mac)?\.yml$/.test(href);
}

async function get(base, p) {
  const r = await fetch(`${base}${p}`);
  const cache = r.headers.get("cache-control") || "";
  assert.equal(cache, "no-store", `cache-control on ${r.status} for ${p}: ${cache}`);
  return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text(), cache };
}

// ── 1. Happy path: both channels rewrite to GitHub download URLs ────────────
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  await withRelay(stubGithub({ releases, ymls }), 60_000, async (base) => {
    const win = await get(base, "/update/win/latest.yml");
    assert.equal(win.status, 200, `win status ${win.status} ${win.text}`);
    assert.match(win.type, /yaml/, `win content-type ${win.type}`);
    assert.match(win.text, new RegExp(`${GH}/v3\\.7\\.0/Grok-Build-Desktop-3\\.7\\.0-win-x64\\.exe`));
    assert.match(win.text, new RegExp(`sha512: ${SHA_WIN}`));
    assert.match(win.text, /size: 84167424/);
    assert.match(win.text, /version: 3\.7\.0/);
    assert.doesNotMatch(win.text, /blockmap/i);
    assert.doesNotMatch(win.text, /<html/i);

    const mac = await get(base, "/update/mac/latest-mac.yml");
    assert.equal(mac.status, 200, `mac status ${mac.status} ${mac.text}`);
    assert.match(mac.type, /yaml/, `mac content-type ${mac.type}`);
    assert.match(mac.text, new RegExp(`${GH}/v3\\.7\\.0/Grok-Build-Desktop-3\\.7\\.0-mac-arm64\\.zip`));
    assert.match(mac.text, new RegExp(`${GH}/v3\\.7\\.0/Grok-Build-Desktop-3\\.7\\.0-mac-x64\\.zip`));
    assert.match(mac.text, new RegExp(`sha512: ${SHA_ARM}`));
    assert.match(mac.text, new RegExp(`sha512: ${SHA_X64}`));
    log("happy path: both channels rewrite urls and keep sha512/size/version");
  });
}

// ── 2. A vsix-only latest is skipped ───────────────────────────────────────
{
  const releases = [vsixOnly("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  await withRelay(stubGithub({ releases, ymls }), 60_000, async (base) => {
    const win = await get(base, "/update/win/latest.yml");
    assert.equal(win.status, 200);
    assert.match(win.text, /version: 3\.7\.0/);
    assert.doesNotMatch(win.text, /3\.8\.0/);
    const mac = await get(base, "/update/mac/latest-mac.yml");
    assert.equal(mac.status, 200);
    assert.match(mac.text, /version: 3\.7\.0/);
    log("vsix-only latest is skipped; the previous desktop yml is served");
  });
}

// ── 3. A one-arch mac yml is refused; the previous dual-arch feed stays ────
{
  // Both zips are attached (so this is not filtered at the asset list) but
  // the yml only names arm64 — the electron-builder #5592 failure mode.
  const oneArch = desktopRelease("3.8.0");
  const releases = [oneArch, desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macOneArchYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  await withRelay(stubGithub({ releases, ymls }), 60_000, async (base) => {
    const mac = await get(base, "/update/mac/latest-mac.yml");
    assert.equal(mac.status, 200, `mac status ${mac.status} ${mac.text}`);
    assert.match(mac.text, /version: 3\.7\.0/, "one-arch 3.8.0 must not become the mac feed");
    assert.match(mac.text, /mac-x64\.zip/);
    const win = await get(base, "/update/win/latest.yml");
    assert.equal(win.status, 200);
    assert.match(win.text, /version: 3\.8\.0/, "Windows is still allowed to move independently");
    log("one-arch mac yml is refused; Windows can still take the newer release");
  });
}

// ── 4. NO stale-serve: GitHub down keeps the cache only until the TTL ──────
// Within the TTL the cached copy answers (an outage is invisible). Beyond it
// a failed refresh is a real 503 — never a copy older than one TTL — and the
// failure is backed off so an outage does not turn every GET into a walk.
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let fail = false;
  let githubCalls = 0;
  const fetchImpl = (input, init) => {
    githubCalls++;
    return stubGithub({ releases, ymls, fail })(input, init);
  };
  await withRelay(
    fetchImpl,
    50,
    async (base) => {
      const first = await get(base, "/update/win/latest.yml");
      assert.equal(first.status, 200);
      fail = true;
      const warm = await get(base, "/update/win/latest.yml");
      assert.equal(warm.status, 200, "within the TTL the cached copy still answers");
      assert.equal(warm.text, first.text);
      await new Promise((r) => setTimeout(r, 80));
      const down = await get(base, "/update/win/latest.yml");
      assert.equal(down.status, 503, `expected 503 past the TTL, got ${down.status} ${down.text}`);
      assert.doesNotMatch(down.text, /version: 3\.7\.0/);
      const callsAfterFail = githubCalls;
      const backedOff = await get(base, "/update/win/latest.yml");
      assert.equal(backedOff.status, 503);
      assert.equal(githubCalls, callsAfterFail, "a failed refresh must back off, not re-walk per GET");
      log("API-down past the TTL is 503 (no stale copy), and the failure is backed off");
    },
    { failBackoffMs: 60_000 },
  );
}

// ── 4b. GitHub down with no cache is a real error, never HTML-with-200 ─────
{
  await withRelay(stubGithub({ releases: [], ymls: {}, fail: true }), 60_000, async (base) => {
    const r = await get(base, "/update/win/latest.yml");
    assert.equal(r.status, 503, `expected 503, got ${r.status}`);
    assert.doesNotMatch(r.text, /<html/i);
    assert.doesNotMatch(r.type, /html/i);
    log("API-down with no cache returns 503, not HTML");
  });
}

// ── 4c. Nothing to serve is 404, not an empty 200 ──────────────────────────
{
  await withRelay(stubGithub({ releases: [vsixOnly("3.8.0")], ymls: {} }), 60_000, async (base) => {
    const r = await get(base, "/update/mac/latest-mac.yml");
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    assert.doesNotMatch(r.text, /<html/i);
    log("no installer-bearing release returns 404");
  });
}

// ── 5. Operator kill-switch: GitHub is UP, ymls deleted, flip to 404 ───────
// Deleting latest.yml assets is how an operator stops a bad unsigned update.
// After a good fetch, a refresh that sees GitHub answer with the ymls gone
// must 404 within one TTL — not keep serving the yanked copy until restart.
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let yanked = false;
  let githubCalls = 0;
  const fetchImpl = (input, init) => {
    githubCalls++;
    if (yanked) {
      return stubGithub({
        releases: [desktopRelease("3.7.0", { win: false, mac: false })],
        ymls: {},
      })(input, init);
    }
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200, `first status ${first.status} ${first.text}`);
    yanked = true;
    await new Promise((r) => setTimeout(r, 40));
    const gone = await get(base, "/update/win/latest.yml");
    assert.equal(gone.status, 404, `expected 404 after yank, got ${gone.status} ${gone.text}`);
    assert.doesNotMatch(gone.text, /version: 3\.7\.0/);
    assert.doesNotMatch(gone.text, /<html/i);
    log("yanked ymls flip to 404 after TTL, not last-good");

    const callsAfterYank = githubCalls;
    const cached404 = await get(base, "/update/win/latest.yml");
    assert.equal(cached404.status, 404, `cached 404 status ${cached404.status}`);
    assert.equal(
      githubCalls,
      callsAfterYank,
      "successful empty refresh must be cached; a GET inside the TTL must not refetch",
    );
    log("successful empty is cached as 404 until TTL expiry");
  });
}

// ── 5b. List still names latest.yml; its download 404s → 404, not last-good ─
// The operator-yank in §5 removes the asset from the releases list, so
// candidates.length===0 short-circuits. The live yank is often the other
// shape: GitHub's list still carries the yml, the bytes are already gone.
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let yanked = false;
  const fetchImpl = (input, init) => {
    if (yanked) return stubGithub({ releases, ymls: {} })(input, init);
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200, `first status ${first.status} ${first.text}`);
    yanked = true;
    await new Promise((r) => setTimeout(r, 40));
    const gone = await get(base, "/update/win/latest.yml");
    assert.equal(gone.status, 404, `expected 404 after yml-download 404, got ${gone.status} ${gone.text}`);
    assert.doesNotMatch(gone.text, /version: 3\.7\.0/);
    log("yml-download 404 with the list still naming it flips to 404, not last-good");
  });
}

// ── 5c. last-good = yanked newest; newest 404 + older 503 → 503, and the
// yanked copy is never re-served (transport means "gone" was not established)
{
  const releases = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let mixed = false;
  const mixedYmls = [];
  const fetchImpl = (input, init) => {
    const href = hrefOf(input);
    if (mixed && isYmlDownload(href)) mixedYmls.push(href);
    if (mixed) {
      return stubGithub({
        releases,
        ymls,
        ymlStatus: { "v3.8.0:latest.yml": 404, "v3.7.0:latest.yml": 503 },
      })(input, init);
    }
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200);
    assert.match(first.text, /version: 3\.8\.0/);
    mixed = true;
    await new Promise((r) => setTimeout(r, 40));
    const gone = await get(base, "/update/win/latest.yml");
    // Transport on the older candidate means "nothing publishable" was not
    // established — the answer is 503, and above all NOT the yanked 3.8.0.
    assert.equal(gone.status, 503, `expected 503 on mixed 404+503, got ${gone.status} ${gone.text}`);
    assert.doesNotMatch(gone.text, /version: 3\.8\.0/);
    assert.doesNotMatch(gone.text, /version: 3\.7\.0/);
    assert.ok(
      mixedYmls.some((h) => h.includes("/v3.8.0/latest.yml")),
      `expected newest yml fetch, got ${mixedYmls.join(", ")}`,
    );
    assert.ok(
      mixedYmls.some((h) => h.includes("/v3.7.0/latest.yml")),
      `older candidate must be fetched so a return-on-first-404 cannot hide; got ${mixedYmls.join(", ")}`,
    );
    log("last-good=yanked newest: 404+503 is 503 — the yanked copy is never re-served");
  });
}

// ── 5d. A yml 410 is the same definitive miss as a 404 ─────────────────────
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let gone = false;
  const fetchImpl = (input, init) => {
    if (gone) {
      return stubGithub({
        releases,
        ymls,
        ymlStatus: { "v3.7.0:latest.yml": 410 },
      })(input, init);
    }
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200);
    gone = true;
    await new Promise((r) => setTimeout(r, 40));
    const r = await get(base, "/update/win/latest.yml");
    assert.equal(r.status, 404, `expected 404 after yml 410, got ${r.status} ${r.text}`);
    assert.doesNotMatch(r.text, /version: 3\.7\.0/);
    log("yml 410 flips to 404, not last-good");
  });
}

// ── 5e. Yank newest only; previous yml still 200 → previous feed is served ─
// Both ymls must be fetched: returning on the first 404 would miss 3.7.0.
{
  const releases = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  let yankedNewest = false;
  const postYankYmls = [];
  const fetchImpl = (input, init) => {
    const href = hrefOf(input);
    if (yankedNewest && isYmlDownload(href)) postYankYmls.push(href);
    if (yankedNewest) {
      return stubGithub({
        releases,
        ymls,
        ymlStatus: { "v3.8.0:latest.yml": 404 },
      })(input, init);
    }
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200);
    assert.match(first.text, /version: 3\.8\.0/);
    yankedNewest = true;
    await new Promise((r) => setTimeout(r, 40));
    const prev = await get(base, "/update/win/latest.yml");
    assert.equal(prev.status, 200, `expected previous feed, got ${prev.status} ${prev.text}`);
    assert.match(prev.text, /version: 3\.7\.0/);
    assert.doesNotMatch(prev.text, /3\.8\.0/);
    assert.equal(postYankYmls.length, 2, `expected both ymls fetched, got ${postYankYmls.join(", ")}`);
    assert.ok(postYankYmls.some((h) => h.includes("/v3.8.0/latest.yml")));
    assert.ok(postYankYmls.some((h) => h.includes("/v3.7.0/latest.yml")));
    log("yank newest only, previous still 200: older feed served; both ymls fetched");
  });
}

// ── 5f. Transient transport heals: 404+503 is a brief 503, then the older
// feed returns once the transport blip clears (nothing wrong ever cached) ──
{
  const olderOnly = [desktopRelease("3.7.0")];
  const both = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  // phase 0: only 3.7.0 exists; phase 1: newest yanked + older 503s;
  // phase 2: the 503 clears (newest still yanked).
  let phase = 0;
  const fetchImpl = (input, init) => {
    if (phase === 1) {
      return stubGithub({
        releases: both,
        ymls,
        ymlStatus: { "v3.8.0:latest.yml": 404, "v3.7.0:latest.yml": 503 },
      })(input, init);
    }
    if (phase === 2) {
      return stubGithub({
        releases: both,
        ymls,
        ymlStatus: { "v3.8.0:latest.yml": 404 },
      })(input, init);
    }
    return stubGithub({ releases: olderOnly, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200);
    assert.match(first.text, /version: 3\.7\.0/);
    phase = 1;
    await new Promise((r) => setTimeout(r, 40));
    const during = await get(base, "/update/win/latest.yml");
    assert.equal(during.status, 503, `expected 503 during the blip, got ${during.status} ${during.text}`);
    phase = 2;
    await new Promise((r) => setTimeout(r, 40));
    const healed = await get(base, "/update/win/latest.yml");
    assert.equal(healed.status, 200, `expected the older feed after the blip, got ${healed.status} ${healed.text}`);
    assert.match(healed.text, /version: 3\.7\.0/);
    assert.doesNotMatch(healed.text, /3\.8\.0/);
    log("transient 503 beside a yank: brief 503, then the older feed self-heals");
  });
}

// ── 6. Content-Length above the cap rejects that candidate ─────────────────
{
  const releases = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  await withRelay(
    stubGithub({
      releases,
      ymls,
      ymlHeaders: { "v3.8.0:latest.yml": { "content-length": String(64 * 1024 + 1) } },
    }),
    60_000,
    async (base) => {
      const win = await get(base, "/update/win/latest.yml");
      assert.equal(win.status, 200, `oversized-newest status ${win.status} ${win.text}`);
      assert.match(win.text, /version: 3\.7\.0/, "content-length over the cap must not become the feed");
      assert.doesNotMatch(win.text, /3\.8\.0/);
      log("content-length over the cap rejects that candidate; the next feed is served");
    },
  );
}

// ── 7. More than UPDATE_FEED_MAX_CANDIDATES ymls only ever fetches that many
{
  const versions = ["3.9.6", "3.9.5", "3.9.4", "3.9.3", "3.9.2", "3.9.1", "3.9.0"];
  assert.ok(
    versions.length > UPDATE_FEED_MAX_CANDIDATES,
    `fixture must exceed the cap (${UPDATE_FEED_MAX_CANDIDATES})`,
  );
  const releases = versions.map((v) => desktopRelease(v));
  let ymlFetches = 0;
  const fetchImpl = (input, init) => {
    const href = hrefOf(input);
    if (isYmlDownload(href)) ymlFetches++;
    return stubGithub({ releases, ymls: {} })(input, init);
  };
  await withRelay(fetchImpl, 60_000, async (base) => {
    const r = await get(base, "/update/win/latest.yml");
    assert.equal(r.status, 404);
    assert.equal(
      ymlFetches,
      UPDATE_FEED_MAX_CANDIDATES,
      `expected ${UPDATE_FEED_MAX_CANDIDATES} yml fetches, got ${ymlFetches}`,
    );
    log(`releases with ${versions.length} yml-bearing tags fetched ${ymlFetches} ymls (cap ${UPDATE_FEED_MAX_CANDIDATES})`);
  });
}

// ── 8. All candidates oversized → transport → 503 (not a 404 wipe, and
// never a copy older than the TTL)
{
  const releases = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.8.0:latest.yml": winYml("3.8.0"),
    "v3.8.0:latest-mac.yml": macYml("3.8.0"),
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  const tooBig = { "content-length": String(64 * 1024 + 1) };
  let oversized = false;
  const oversizedYmls = [];
  const fetchImpl = (input, init) => {
    const href = hrefOf(input);
    if (oversized && isYmlDownload(href)) oversizedYmls.push(href);
    if (oversized) {
      return stubGithub({
        releases,
        ymls,
        ymlHeaders: { "v3.8.0:latest.yml": tooBig, "v3.7.0:latest.yml": tooBig },
      })(input, init);
    }
    return stubGithub({ releases, ymls })(input, init);
  };
  await withRelay(fetchImpl, 20, async (base) => {
    const first = await get(base, "/update/win/latest.yml");
    assert.equal(first.status, 200);
    assert.match(first.text, /version: 3\.8\.0/);
    oversized = true;
    await new Promise((r) => setTimeout(r, 40));
    const failed = await get(base, "/update/win/latest.yml");
    assert.equal(failed.status, 503, `expected 503 on all-oversized, got ${failed.status} ${failed.text}`);
    assert.doesNotMatch(failed.text, /version: 3\.8\.0/);
    assert.equal(oversizedYmls.length, 2, `expected both ymls fetched, got ${oversizedYmls.join(", ")}`);
    log("all candidates oversized is transport: 503, both fetched, nothing wrong cached");
  });
}

// ── 9. A second good yml after a 404 is served (null-branch fallthrough) ───
// Distinct from §3, which pins rewrite-reject fallthrough. Returning on the
// first null (yml 404) would 404 the channel even though 3.7.0 is a feed.
{
  const releases = [desktopRelease("3.8.0"), desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  const fetched = [];
  const fetchImpl = (input, init) => {
    const href = hrefOf(input);
    if (isYmlDownload(href)) fetched.push(href);
    return stubGithub({
      releases,
      ymls,
      ymlStatus: { "v3.8.0:latest.yml": 404 },
    })(input, init);
  };
  await withRelay(fetchImpl, 60_000, async (base) => {
    const win = await get(base, "/update/win/latest.yml");
    assert.equal(win.status, 200, `expected older feed after newest 404, got ${win.status} ${win.text}`);
    assert.match(win.text, /version: 3\.7\.0/);
    assert.doesNotMatch(win.text, /3\.8\.0/);
    assert.ok(fetched.some((h) => h.includes("/v3.8.0/latest.yml")));
    assert.ok(fetched.some((h) => h.includes("/v3.7.0/latest.yml")));
    log("second good yml after a 404 is served (null-branch fallthrough)");
  });
}

// ── 10. Concurrent GETs on a cold cache share one walk ─────────────────────
// The in-flight slot is the piece four review rounds circled. Without a hold,
// this shape is satisfied by the cache (second GET hits what the first just
// wrote) or the backoff — so the stub GATES the yml download on a manually
// released promise until BOTH requests are provably inside loadUpdateFeed.
// The yml fetch count is the discriminator: cachedReleases has its own
// in-flight dedup, so only ymlCalls distinguishes the feed-level slot.
{
  const releases = [desktopRelease("3.7.0")];
  const ymls = {
    "v3.7.0:latest.yml": winYml("3.7.0"),
    "v3.7.0:latest-mac.yml": macYml("3.7.0"),
  };
  const makeGate = () => {
    let release;
    const promise = new Promise((r) => (release = r));
    return { promise, release };
  };
  let holdYml = null;
  let failYml = false;
  let ymlCalls = 0;
  const fetchImpl = async (input, init) => {
    const href = hrefOf(input);
    if (isYmlDownload(href)) {
      ymlCalls++;
      if (holdYml) await holdYml.promise;
    }
    return stubGithub({
      releases,
      ymls,
      ymlStatus: failYml ? { "v3.7.0:latest.yml": 503 } : {},
    })(input, init);
  };
  await withRelay(fetchImpl, 50, async (base) => {
    holdYml = makeGate();
    const pa = get(base, "/update/win/latest.yml");
    const pb = get(base, "/update/win/latest.yml");
    // Let both request handlers reach loadUpdateFeed while the walk is held.
    await new Promise((r) => setTimeout(r, 20));
    holdYml.release();
    holdYml = null;
    const [a, b] = await Promise.all([pa, pb]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.text, b.text, "concurrent callers must see the same body");
    assert.equal(ymlCalls, 1, `overlapping GETs must share one yml fetch, got ${ymlCalls}`);

    failYml = true;
    await new Promise((r) => setTimeout(r, 80));
    const ymlBefore = ymlCalls;
    holdYml = makeGate();
    const pc = get(base, "/update/win/latest.yml");
    const pd = get(base, "/update/win/latest.yml");
    await new Promise((r) => setTimeout(r, 20));
    holdYml.release();
    holdYml = null;
    const [c, d] = await Promise.all([pc, pd]);
    assert.equal(c.status, 503);
    assert.equal(d.status, 503);
    assert.equal(
      ymlCalls,
      ymlBefore + 1,
      `overlapping failures must share one walk, got ${ymlCalls - ymlBefore} yml fetches`,
    );
    log("concurrent GETs share one held walk (success and failure)");
  });
}

console.log("[update-feed] ALL CHECKS PASSED");
