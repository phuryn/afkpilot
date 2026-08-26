// Remote sign-in — the whole flow, through a real relay and the real /chat page.
//
// WHY THIS EXISTS. Connecting an agent from a phone crosses every seam this
// project has: a click in the vendored web client, a WebviewMsg through the
// relay's hub, the extension's remote-policy gate, a host that spawns a CLI,
// and a HostMsg carrying a URL and a short code all the way back to the phone.
// The vitest DOM suites cover the client half and the unit suites cover the
// host half, and NEITHER can see the wire between them — which is exactly where
// this feature would break, because until 2026-08-26 `runGrokLogin` was
// classified host-local and the relay would have dropped it on the floor.
//
// So this drives the real page against a scripted host and asserts the two
// things that only an end-to-end run can: that the click ARRIVES, and that the
// code COMES BACK and is on screen. Screenshots land in .screens/ for a person
// to look at, because "the code is in the DOM" and "the code is legible on a
// phone" are different claims.
//
// Run: npm run e2e:signin
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { chromium } from "playwright";

const PORT = Number(process.env.SIGNIN_PORT || 8801);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.SCREENS_DIR || ".screens";
const CWD = "/work/grok-remote";
const log = (m) => console.log(`[signin] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

// Verbatim from `grok login --device-auth` on 2026-08-26. Using the real string
// rather than a tidy one keeps the client honest about a URL that carries the
// code in its own query string.
const REAL_URL = "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS";
const REAL_CODE = "SDCN-9XZS";

rmSync(join(OUT, "signin"), { recursive: true, force: true });
mkdirSync(join(OUT, "signin"), { recursive: true });

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, RELAY_PORT: String(PORT), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
let relayStderr = "";
relay.stderr.on("data", (d) => { relayStderr += String(d); });

const postJson = async (p, body) =>
  (await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const waitFor = async (fn, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

let browser, uplink;
try {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, "the relay to listen", 15000);
  if (relay.exitCode !== null) {
    throw new Error(`relay exited (code ${relay.exitCode}) — port ${PORT} taken?\n${relayStderr.slice(0, 500)}`);
  }

  const started = await postJson("/api/link/start", { name: "signin box" });
  await postJson("/api/link/approve", { code: started.code });
  const token = (await postJson("/api/link/poll", { code: started.code })).token;

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((res, rej) => { uplink.once("open", res); uplink.once("error", rej); });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "Pawel-Desk" } }));

  const snapshot = (clientId, msgs) => uplink.send(JSON.stringify({ t: "snapshot", clientId, msgs }));
  const host = (clientId, msg) => uplink.send(JSON.stringify({ t: "host-to", clientIds: [clientId], msg }));
  let clientId = "";
  /** Everything the browser sent us. The assertions read this. */
  const fromClient = [];

  uplink.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === "client-ready") {
      clientId = f.clientId;
      snapshot(f.clientId, [
        { type: "clearMessages" },
        {
          type: "initialState", version: "signin", cwd: CWD, extVersion: "3.18.0",
          hostKind: "desktop", hostName: "Pawel-Desk",
          capabilities: { uploadFile: true },
        },
        {
          type: "repos",
          entries: [{ cwd: CWD, label: "grok-remote", available: true, pinned: false, updatedAt: 3, archived: false, color: "" }],
          selectedCwd: CWD, activeCwd: CWD, workspaceCwd: CWD, canAddProject: false,
        },
        // `info` is not optional — the protocol requires it and the single
        // sender in sidebar.ts always supplies it. Sending a bare `initialized`
        // throws in the client, which is how this fixture was wrong before it
        // was right; the client is correct to assume its own protocol.
        { type: "initialized", info: { cliPath: "/usr/bin/grok", cwd: CWD, version: "1.0.5", provider: "grok", init: {} } },
        // Nothing connected: the panel this feature replaces.
        { type: "onboarding", state: "auth-required", platform: "linux", provider: "grok" },
      ]);
      return;
    }
    if (f.t === "msg") fromClient.push(f.msg);
  });

  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : {});
  // A phone, because that is the surface this exists for.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  // The stack, not just the message: a page error in the vendored client is a
  // needle in 17k lines, and "TypeError: ... reading 'provider'" on its own
  // sends you looking in the wrong function.
  page.on("pageerror", (e) => pageErrors.push(String(e?.stack || e)));
  // Named device, as the picker would hand over — /chat with no device sits on
  // the picker and never opens an uplink client.
  const deviceId = ((await (await fetch(`${BASE}/api/devices`)).json()).devices || [])[0]?.deviceId;
  assert.ok(deviceId, "the uplink must register a device");
  await page.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`, { waitUntil: "load" });

  await waitFor(async () => clientId, "the browser to attach");
  const connectBtn = page.locator('[data-act="connectRemote"][data-provider="grok"]');
  await connectBtn.waitFor({ state: "visible", timeout: 15000 });
  log("the panel offers a sign-in");

  // The dead end this replaces. If that copy is back, the feature is off.
  const panelText = await page.locator("#welcome-onboarding").innerText();
  assert.ok(
    !/only be connected on the computer/i.test(panelText),
    `the panel still says sign-in is impossible here:\n${panelText}`,
  );
  await page.screenshot({ path: join(OUT, "signin", "1-offer.png"), fullPage: false });

  // 1. The click has to CROSS THE RELAY. This is the assertion that would have
  //    failed while runGrokLogin was host-local, with everything else green.
  await connectBtn.click();
  const asked = await waitFor(
    () => fromClient.find((m) => m.type === "runGrokLogin"),
    "runGrokLogin to reach the host",
  );
  assert.equal(asked.provider, "grok", "the request must name the provider");
  log("the click reached the host through the relay");

  // 2. Starting, then the code. Both are real states with real durations, so
  //    both are rendered.
  host(clientId, {
    type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
    launched: true, device: { status: "starting" },
  });
  await page.locator('[data-act="cancelDeviceLogin"]').waitFor({ state: "visible", timeout: 8000 });
  await page.screenshot({ path: join(OUT, "signin", "2-starting.png") });
  log("the waiting state is on screen");

  host(clientId, {
    type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
    launched: true, device: { status: "waiting", url: REAL_URL, code: REAL_CODE },
  });
  const codeEl = page.locator(".onb-cmd code");
  await codeEl.waitFor({ state: "visible", timeout: 8000 });
  assert.equal((await codeEl.innerText()).trim(), REAL_CODE, "the code must be the one the CLI printed");

  const link = page.locator("a.onb-action");
  assert.equal(await link.getAttribute("href"), REAL_URL, "the link must be the URL the CLI printed");
  assert.equal(await link.getAttribute("target"), "_blank", "a phone has to leave this page to authorise");

  // Legible, not merely present. This is the half a DOM test cannot make.
  const box = await codeEl.boundingBox();
  assert.ok(box && box.width > 40 && box.height > 8, `the code is not rendered: ${JSON.stringify(box)}`);
  const linkBox = await link.boundingBox();
  assert.ok(linkBox && linkBox.height >= 28, `the sign-in link is not a tappable size: ${JSON.stringify(linkBox)}`);

  // The primary action has to be READABLE, which is not the same as present.
  // It shipped once as dark link-blue text on the blue button fill, because the
  // client's global `a { color: textLink-foreground }` was beating the button
  // class — every assertion above still passed and the button was effectively
  // blank. Contrast is the only thing that catches that.
  const contrast = await link.evaluate((el) => {
    const parse = (c) => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const cs = getComputedStyle(el);
    let bgEl = el;
    let bg = cs.backgroundColor;
    while (bgEl && (!bg || bg === "transparent" || /rgba\(0, 0, 0, 0\)/.test(bg))) {
      bgEl = bgEl.parentElement;
      bg = bgEl ? getComputedStyle(bgEl).backgroundColor : "rgb(255,255,255)";
    }
    const a = lum(parse(cs.color));
    const b = lum(parse(bg));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return { color: cs.color, background: bg, ratio: Math.round(ratio * 100) / 100 };
  });
  assert.ok(
    contrast.ratio >= 4.5,
    `the sign-in link is unreadable on its own button: ${contrast.color} on ${contrast.background} `
    + `is ${contrast.ratio}:1 (want >= 4.5)`,
  );
  log(`the sign-in link contrasts ${contrast.ratio}:1`);
  // Nothing may hang off the side of a 390px phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `the panel overflows the viewport by ${overflow}px`);
  await page.screenshot({ path: join(OUT, "signin", "3-code.png") });
  log(`the code and link are on screen and tappable (${Math.round(linkBox.height)}px)`);

  // 3. Cancel has to reach the host too, or the only person who can see the
  //    panel cannot close it.
  fromClient.length = 0;
  await page.locator('[data-act="cancelDeviceLogin"]').click();
  const cancelled = await waitFor(
    () => fromClient.find((m) => m.type === "cancelDeviceLogin"),
    "cancelDeviceLogin to reach the host",
  );
  assert.equal(cancelled.provider, "grok");
  log("cancel reached the host");

  // 4. A provider that cannot work here says so, and offers no retry — a dead
  //    end disguised as a loop is worse than a dead end.
  host(clientId, {
    type: "onboarding", state: "claude-login", platform: "linux", provider: "claude",
    device: {
      status: "unavailable",
      message: "Claude's sign-in needs a real terminal, so it has to be done at your computer.",
    },
  });
  await waitFor(
    async () => (await page.locator("#welcome-onboarding").innerText()).includes("real terminal"),
    "the unavailable explanation",
  );
  assert.equal(
    await page.locator('[data-act="connectRemote"]').count(), 0,
    "an unavailable provider must not offer a retry",
  );
  await page.screenshot({ path: join(OUT, "signin", "4-unavailable.png") });
  log("an impossible provider explains itself and offers no retry");

  // 5. A failure that retrying could fix DOES offer one.
  host(clientId, {
    type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
    device: { status: "failed", message: "Grok sign-in did not complete. The code may have expired — try again." },
  });
  await page.locator('[data-act="connectRemote"]').waitFor({ state: "visible", timeout: 8000 });
  await page.screenshot({ path: join(OUT, "signin", "5-failed.png") });
  log("a retryable failure offers a retry");

  // 6. And success closes it out.
  host(clientId, {
    type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
    device: { status: "done" },
  });
  await waitFor(
    async () => (await page.locator("#welcome-onboarding").innerText()).includes("connected"),
    "the connected confirmation",
  );
  await page.screenshot({ path: join(OUT, "signin", "6-done.png") });
  log("success is confirmed");

  assert.deepEqual(pageErrors, [], "the page must throw nothing");
  log(`screens in ${join(OUT, "signin")}`);
  log("ALL CHECKS PASSED");
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { uplink?.close(); } catch { /* */ }
  relay.kill();
}
