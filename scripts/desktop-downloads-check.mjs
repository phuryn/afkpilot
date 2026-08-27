// Download-discovery check for /desktop — the installer links are resolved at
// page load from the GitHub Releases API, so nothing in vitest can tell you
// whether a real visitor ends up with a working button or a dead one.
//
// The failure this exists to catch is silent by construction: a release whose
// asset names drift from electron-builder's artifactName leaves the page
// looking fine and every button disabled, and the only symptom is nobody
// downloading anything. The fixtures below therefore carry the REAL asset
// names produced by electron-builder.yml — if that config changes, this fails.
//
// Intercepts api.github.com so the check never depends on the network, on a
// release existing, or on GitHub's rate limit. Run: npm run e2e:downloads
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const PORT = Number(process.env.DOWNLOADS_CHECK_PORT || 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[downloads] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

// Exactly what `npm run dist:win` / `dist:mac` emit today.
const REAL_ASSETS = [
  { name: "Grok-Build-Desktop-3.2.0-mac-arm64.dmg", size: 96 * 1024 * 1024 },
  { name: "Grok-Build-Desktop-3.2.0-mac-x64.dmg", size: 101 * 1024 * 1024 },
  { name: "Grok-Build-Desktop-3.2.0-win-x64.exe", size: 83537885 },
  { name: "Grok-Build-Desktop-3.2.0-win-x64.exe.blockmap", size: 89079 },
];

const asset = (a) => ({
  name: a.name,
  size: a.size,
  browser_download_url: `https://github.com/phuryn/grok-build-vscode/releases/download/v3.2.0/${a.name}`,
});

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
    // Cleared for the same reason as Clerk and Supabase above: the relay reads
    // a maintainer's .env, and one with SPRITES_TOKEN in it adds a cloud row to
    // every device list. A gate that passes or fails depending on whose machine
    // runs it is not a gate. Cloud has its own: e2e:cloud.
    SPRITES_TOKEN: "",
    SPRITES_LABELS: "",
    SUPABASE_URL: "",
    SUPABASE_SECRET_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", () => {});

async function waitForRelay() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`relay never came up on ${BASE}`);
}

/** Load /desktop with the releases API stubbed to `respond`, then read the UI. */
async function loadWith(browser, respond, deviceName = "Desktop Chrome") {
  const context = await browser.newContext(
    deviceName === "Desktop Chrome"
      ? { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" }
      : devices[deviceName],
  );
  const page = await context.newPage();
  await page.route("https://api.github.com/**", respond);
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  // The buttons settle asynchronously; wait for the "Detecting…" placeholder to go.
  await page.waitForFunction(
    () => !/Detecting/.test(document.getElementById("primary-download").textContent),
    null,
    { timeout: 10000 },
  );
  const state = await page.evaluate(() => {
    // .download-option, not [data-download-key]: configureButton stamps that
    // attribute onto the primary button too, and the primary has no <small>.
    const options = Array.from(document.querySelectorAll(".download-option")).map((b) => ({
      key: b.dataset.downloadKey,
      disabled: b.disabled,
      detail: b.querySelector("small").textContent,
      current: b.getAttribute("aria-current"),
      url: b.dataset.downloadUrl || "",
    }));
    return {
      primaryText: document.getElementById("primary-download").textContent,
      primaryDisabled: document.getElementById("primary-download").disabled,
      status: document.getElementById("download-status").textContent,
      help: document.getElementById("download-help").textContent,
      releaseLink: document.querySelector(".release-link").href,
      // One note per OS since 3.2.7 — macOS says "signed and notarised", Windows
      // still warns about SmartScreen. The assertion is that the detected
      // platform gets ITS note, not that a single shared banner exists.
      firstRunNoteShown: ["macos-signed-note", "windows-open-note"].some(function (id) {
        const el = document.getElementById(id);
        return !!el && !el.hidden;
      }),
      agentReachDisclosed: /reads and edits files and runs commands/i.test(document.body.textContent),
      options,
    };
  });
  await context.close();
  return state;
}

// Honours ?per_page the way GitHub does. Without this the stub hands back every
// release regardless of the page size the page asked for, and the "long run of
// extension-only releases" check below passes no matter how small that page is
// — which is exactly what it happened to do when first written.
const json = (body) => (route) => {
  let payload = body;
  if (Array.isArray(body)) {
    const perPage = Number(new URL(route.request().url()).searchParams.get("per_page") || 30);
    payload = body.slice(0, Math.max(1, Math.min(perPage, 100)));
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
};

let browser;
try {
  await waitForRelay();
  browser = await chromium.launch(
    browserExecutable ? { executablePath: browserExecutable } : undefined,
  );

  // ── 1. A real release: every platform resolves, sizes shown ──────────────
  {
    const state = await loadWith(
      browser,
      json([{ tag_name: "v3.2.0", draft: false, assets: REAL_ASSETS.map(asset) }]),
    );
    for (const option of state.options) {
      assert.equal(option.disabled, false, `${option.key} should be enabled for a real release`);
    }
    assert.match(state.primaryText, /^Download macOS/, "a Mac UA gets a Mac primary button");
    assert.match(state.status, /v3\.2\.0/, "the status line names the release");
    const win = state.options.find((o) => o.key === "windowsX64");
    assert.match(win.detail, /80 MB/, `size should be shown, got "${win.detail}"`);
    assert.equal(state.firstRunNoteShown, true, "the detected platform must get its first-run note");
    // What the thing DOES is as much a part of informed consent as who signed
    // it. Shipping an agent that edits files and runs commands without saying
    // so on the download page is the omission people would be angriest about.
    assert.equal(state.agentReachDisclosed, true, "the page must say what the agent can reach");
    log("a published release enables all three platforms, with sizes and the tag");
  }

  // ── 2. The blockmap must not be mistaken for the installer ───────────────
  {
    // `-win-x64.exe.blockmap` contains "-win-x64.exe". An unanchored match
    // would hand every Windows visitor an 89 KB file that installs nothing —
    // and the page would look completely healthy while doing it. Assets are
    // listed blockmap-first here so a first-match-wins bug cannot hide.
    const shuffled = [
      REAL_ASSETS[3], // the .blockmap
      REAL_ASSETS[2], // the .exe
      REAL_ASSETS[0],
      REAL_ASSETS[1],
    ];
    const state = await loadWith(
      browser,
      json([{ tag_name: "v3.2.0", draft: false, assets: shuffled.map(asset) }]),
    );
    const win = state.options.find((o) => o.key === "windowsX64");
    assert.ok(win.url.endsWith(".exe"), `Windows must resolve to the installer, got "${win.url}"`);
    assert.ok(!win.url.includes(".blockmap"), "the blockmap must never be offered as a download");
    const mac = state.options.find((o) => o.key === "macosAppleSilicon");
    assert.ok(mac.url.endsWith("-mac-arm64.dmg"), `Apple silicon must get the arm64 dmg, got "${mac.url}"`);
    const intel = state.options.find((o) => o.key === "macosIntel");
    assert.ok(intel.url.endsWith("-mac-x64.dmg"), `Intel must get the x64 dmg, got "${intel.url}"`);
    log("each platform resolves to its own installer; the blockmap is never offered");
  }

  // ── 3. An extension-only release must not blank the page ─────────────────
  {
    // Releases carrying just a .vsix are the norm on that repo. Taking the
    // newest release unconditionally would disable every button whenever the
    // extension shipped after the desktop app.
    const state = await loadWith(
      browser,
      json([
        { tag_name: "v3.3.0", draft: false, assets: [asset({ name: "grok-vscode-phuryn-3.3.0.vsix", size: 5e6 })] },
        { tag_name: "v3.2.0", draft: false, assets: REAL_ASSETS.map(asset) },
      ]),
    );
    assert.equal(state.primaryDisabled, false, "should fall back to the newest release WITH installers");
    assert.match(state.status, /v3\.2\.0/, "and name that release, not the vsix-only one");
    log("a later extension-only release falls through to the newest desktop build");
  }

  // ── 4. A draft release is not downloadable by the public ────────────────
  {
    const state = await loadWith(
      browser,
      json([
        { tag_name: "v3.4.0", draft: true, assets: REAL_ASSETS.map(asset) },
        { tag_name: "v3.2.0", draft: false, assets: REAL_ASSETS.map(asset) },
      ]),
    );
    assert.match(state.status, /v3\.2\.0/, "draft assets 404 for anonymous visitors — skip them");
    log("a draft release is skipped in favour of the newest published one");
  }

  // ── 4b. A long run of extension-only releases must not bury the app ──────
  {
    // The desktop app releases far less often than the extension. With a small
    // page size the newest desktop build falls off the end of the response and
    // every button goes dead while working installers sit on GitHub — a failure
    // that looks exactly like "no build exists".
    const vsixOnly = Array.from({ length: 30 }, (_, i) => ({
      tag_name: `v9.${i}.0`,
      draft: false,
      assets: [asset({ name: `grok-vscode-phuryn-9.${i}.0.vsix`, size: 5e6 })],
    }));
    const state = await loadWith(
      browser,
      json([...vsixOnly, { tag_name: "v3.2.0", draft: false, assets: REAL_ASSETS.map(asset) }]),
    );
    assert.equal(state.primaryDisabled, false, "30 extension-only releases must not hide the desktop build");
    assert.match(state.status, /v3\.2\.0/, "and the desktop release is still the one named");
    log("30 newer extension-only releases do not bury the desktop build");
  }

  // ── 5a. GitHub answered, and there is genuinely nothing ─────────────────
  for (const [label, respond] of [
    ["no releases at all", json([])],
    ["a release with no assets", json([{ tag_name: "v3.2.0", draft: false, assets: [] }])],
  ]) {
    const state = await loadWith(browser, respond);
    assert.equal(state.primaryDisabled, true, `${label}: primary must not offer a dead download`);
    assert.match(state.primaryText, /coming soon/i, `${label}: says coming soon`);
    for (const option of state.options) {
      assert.equal(option.disabled, true, `${label}: ${option.key} must stay disabled`);
    }
    assert.match(
      state.releaseLink,
      /github\.com\/phuryn\/grok-build-vscode\/releases/,
      `${label}: the releases page stays reachable`,
    );
    assert.equal(state.firstRunNoteShown, false, `${label}: no first-run note without a download`);
    log(`${label}: no dead buttons, releases link still offered`);
  }

  // ── 5b. GitHub did NOT answer — never claim that as "no build exists" ────
  for (const [label, respond] of [
    ["rate limited", (route) => route.fulfill({ status: 403, contentType: "application/json", body: "{}" })],
    ["network failure", (route) => route.abort()],
    ["a malformed response", json({ message: "Not Found" })],
  ]) {
    const state = await loadWith(browser, respond);
    assert.equal(state.primaryDisabled, true, `${label}: primary must not offer a dead download`);
    // The distinction that matters: a temporary outage told as "not published
    // yet" sends someone away permanently over a problem that fixes itself.
    assert.doesNotMatch(
      state.help,
      /not published yet/i,
      `${label}: must not claim the build does not exist`,
    );
    assert.match(state.primaryText, /unavailable/i, `${label}: says it could not reach GitHub`);
    for (const option of state.options) {
      assert.equal(option.disabled, true, `${label}: ${option.key} must stay disabled`);
    }
    assert.equal(state.firstRunNoteShown, false, `${label}: no first-run note without a download`);
    log(`${label}: reported as unreachable, not as "no build"`);
  }

  // ── 6. A Windows visitor is offered Windows ─────────────────────────────
  {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    });
    const page = await context.newPage();
    await page.route("https://api.github.com/**", json([{ tag_name: "v3.2.0", draft: false, assets: REAL_ASSETS.map(asset) }]));
    await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => /Download/.test(document.getElementById("primary-download").textContent),
      null,
      { timeout: 10000 },
    );
    const text = await page.locator("#primary-download").textContent();
    assert.match(text, /Windows/, `Windows UA should get the Windows build, got "${text}"`);
    await context.close();
    log("a Windows visitor is offered the Windows installer");
  }

  console.log("[downloads] ALL CHECKS PASSED");
} finally {
  if (browser) await browser.close();
  relay.kill();
}
