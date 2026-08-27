// The device picker with a cloud environment in it — in a real browser.
//
// WHY THIS EXISTS. The unit suites prove `deviceAvailability` returns "ready"
// for a sleeping environment. They cannot prove that a person looking at the
// page sees a usable row: happy-dom has no layout, and the difference between
// "ready" and "offline" here is a live link versus a dead grey one. That is a
// rendered fact, and the only way to check it is to render it.
//
// It also pins the thing most likely to be "simplified" back into a bug: a
// sleeping environment must NOT be labelled asleep, and its button must NOT be
// disabled. Opening it is what wakes it.
//
// Run: npm run e2e:cloud
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.CLOUD_PICKER_PORT || 8803);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(process.env.SCREENS_DIR || ".screens", "cloud-picker");
const log = (m) => console.log(`[cloud-picker] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SPRITES_TOKEN: "", SPRITES_LABELS: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
let relayErr = "";
relay.stderr.on("data", (d) => { relayErr += String(d); });

const waitFor = async (fn, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

/**
 * The picker is driven from a STUBBED /api/devices rather than a real hosted
 * machine: the states worth photographing include "a wake just failed", which
 * cannot be produced on demand against a live provider. What is real is the
 * page — its markup, CSS and JavaScript are the shipped ones.
 */
const DEVICES = {
  devices: [
    {
      // The state EVERY account starts in: a row, and no machine behind it.
      deviceId: null,
      name: "Cloud",
      createdAt: null,
      online: false,
      clients: 0,
      clientLabel: "by afkpilot.com",
      platform: "cloud",
      osLabel: null,
      availability: "ready",
      environment: { provider: "sprite", state: "not-provisioned" },
    },
    {
      // What a free account sees once the launch window closes.
      deviceId: null,
      name: "Cloud",
      createdAt: null,
      online: false,
      clients: 0,
      clientLabel: "by afkpilot.com",
      platform: "cloud",
      osLabel: null,
      availability: "upgrade",
      environment: { provider: "sprite", state: "upgrade" },
    },
    {
      deviceId: "d-cloud-sleeping",
      name: "Cloud — Pawel",
      createdAt: Date.now() - 86_400_000,
      online: false,
      clients: 0,
      clientLabel: "by afkpilot.com",
      // A STALE os label, exactly as the owner's real row carries. The relay's
      // updateClient is a patch, so a device that became a cloud environment
      // after it first linked keeps whatever OS it reported back then — and
      // "Cloud — Pawel (by afkpilot.com, Linux)" is what he actually saw.
      osLabel: "Linux",
      platform: "cloud",
      availability: "ready",
      // NO environment record — exactly the owner's row: a cloud machine linked
      // by hand before the relay knew what one was.
      environment: null,
    },
    {
      deviceId: "d-cloud-waking",
      name: "Cloud — build box",
      createdAt: Date.now() - 86_400_000,
      online: false,
      clients: 0,
      clientLabel: "by afkpilot.com",
      platform: "cloud",
      osLabel: null,
      availability: "waking",
      environment: { provider: "sprite" },
    },
    {
      deviceId: "d-cloud-broken",
      name: "Cloud — over limit",
      createdAt: Date.now() - 86_400_000,
      online: false,
      clients: 0,
      clientLabel: "by afkpilot.com",
      platform: "cloud",
      osLabel: null,
      availability: "offline",
      environment: { provider: "sprite" },
    },
    {
      deviceId: "d-laptop",
      name: "DESKTOP-RHFLCK3",
      createdAt: Date.now() - 86_400_000,
      online: false,
      clients: 0,
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
      availability: "offline",
      environment: null,
    },
  ],
};

let browser;
try {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, "the relay to listen");
  if (relay.exitCode !== null) {
    throw new Error(`relay exited (${relay.exitCode}) — port ${PORT} taken?\n${relayErr.slice(0, 400)}`);
  }

  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : {});
  for (const [tag, viewport, isMobile] of [
    ["desk", { width: 1280, height: 900 }, false],
    ["phone", { width: 390, height: 844 }, true],
  ]) {
    const ctx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.stack || e)));
    await page.route("**/api/devices", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DEVICES) }));
    await page.goto(BASE, { waitUntil: "load" });
    await page.locator(".device-row").first().waitFor({ state: "visible", timeout: 15000 });

    const row = (id) => page.locator(`.device-row[data-device-id="${id}"]`);

    // 1. A SLEEPING environment must look usable. This is the whole model.
    const sleeping = row("d-cloud-sleeping");
    const sleepText = (await sleeping.innerText()).replace(/\s+/g, " ");
    assert.ok(!/asleep|paused|warm|cold|hibernat/i.test(sleepText),
      `a sleeping environment must not be described as asleep: ${sleepText}`);
    assert.ok(!/\boffline\b/i.test(sleepText),
      `a wakeable environment must not say offline: ${sleepText}`);
    const startHref = await sleeping.locator("a.device-start").getAttribute("href");
    assert.ok(startHref && startHref.includes("d-cloud-sleeping"),
      "a sleeping environment must offer a LIVE link — opening it is what wakes it");
    assert.equal(await sleeping.locator(".device-start.is-disabled").count(), 0,
      "a sleeping environment's button must not be disabled");

    // 2. It must not claim to run Linux or be a desktop app.
    assert.ok(!/linux|desktop app/i.test(sleepText),
      `a cloud row must not describe its operating system, even a stale one `
      + `stored before it became an environment: ${sleepText}`);
    assert.ok(/afkpilot\.com/i.test(sleepText), `a cloud row should say who runs it: ${sleepText}`);

    // 3. A cloud icon, drawn and sized — not a collapsed empty box.
    const iconBox = await sleeping.locator(".device-os-icon svg").boundingBox();
    assert.ok(iconBox && iconBox.width >= 10 && iconBox.height >= 10,
      `the cloud icon is not rendered: ${JSON.stringify(iconBox)}`);

    // 4. An UNWAKEABLE environment is offline, with a dead button and a message
    //    that does not send someone to VS Code they never installed.
    const broken = row("d-cloud-broken");
    assert.ok(/offline/i.test(await broken.innerText()), "an unwakeable environment reads offline");
    assert.equal(await broken.locator("a.device-start").count(), 0,
      "an unwakeable environment must not offer a live link");
    const brokenTitle = await broken.locator(".device-start").getAttribute("title");
    assert.ok(brokenTitle && !/VS Code/i.test(brokenTitle),
      `an environment must not be explained as a VS Code problem: ${brokenTitle}`);

    // 5. NOT PROVISIONED — the state every account starts in. It must read as
    //    usable, offer a button (not a link: the machine does not exist yet and
    //    opening it has to make one), and never mention provisioning.
    const fresh = page.locator('.device-row[data-cloud-state="not-provisioned"]').first();
    const freshText = (await fresh.innerText()).replace(/\s+/g, " ");
    assert.ok(!/provision|create|set ?up|not created|inactive/i.test(freshText),
      `a fresh cloud row must not talk about provisioning: ${freshText}`);
    assert.ok(!/\boffline\b/i.test(freshText), `a fresh cloud row must not say offline: ${freshText}`);
    assert.equal(await fresh.locator("button.device-start").count(), 1,
      "a fresh cloud row needs a BUTTON — opening it creates the machine");
    assert.equal(await fresh.locator("a.device-start").count(), 0,
      "a fresh cloud row must not be a plain link to a device that does not exist");

    // 6. UPGRADE — visible, and an offer rather than an error. The row exists
    //    precisely so this is discoverable.
    const locked = page.locator('.device-row[data-cloud-state="upgrade"]').first();
    const lockedText = (await locked.innerText()).replace(/\s+/g, " ");
    assert.ok(/upgrade/i.test(lockedText), `a locked cloud row should offer an upgrade: ${lockedText}`);
    const lockedHref = await locked.locator("a.device-start").getAttribute("href");
    assert.equal(lockedHref, "#billing", "the upgrade must go where every other upgrade goes");

    // 7. NO ✕ ON A CLOUD ROW, ever. Unlinking one would leave an account
    //    without a product it cannot get back, and a gap in a list that
    //    promises everyone has one.
    // Including a cloud machine the relay has NO record for — the owner had one
    // of those, unlinked it, and lost every route back to a sprite that was
    // still running.
    assert.equal(await sleeping.locator(".device-remove:not(.device-menu-btn)").count(), 0,
      "a cloud row must never offer an unlink, even without an environment record");
    for (const state of ["not-provisioned", "upgrade"]) {
      const r = page.locator(`.device-row[data-cloud-state="${state}"]`).first();
      assert.equal(await r.locator(".device-remove:not(.device-menu-btn)").count(), 0,
        `a ${state} cloud row must not offer an unlink ✕`);
    }
    const sleepingMenu = sleeping.locator(".device-menu-btn");
    assert.equal(await sleepingMenu.count(), 1, "a cloud row offers ⋯ instead of ✕");
    await sleepingMenu.click();
    const item = sleeping.locator(".device-menu-item");
    assert.equal((await item.innerText()).trim(), "Reset my Cloud");
    // VISIBLE and occupying space, not merely present. A popover that renders
    // behind something, at zero height, or closes on the same click that opened
    // it satisfies every text assertion and shows the reader nothing — which is
    // the exact failure this whole gate exists for.
    await item.waitFor({ state: "visible", timeout: 5000 });
    const menuBox = await item.boundingBox();
    assert.ok(menuBox && menuBox.width > 60 && menuBox.height > 12,
      `the reset menu is not actually rendered: ${JSON.stringify(menuBox)}`);
    // A HIT TEST, because "visible" is not enough. `.device-row` sets
    // `overflow: hidden` so its children respect the rounded corners, and that
    // clipped this popover into invisibility: Playwright still reported it
    // visible with a real box, and the screenshot showed nothing. Asking the
    // page what is actually painted at that point catches clipping, z-index and
    // anything drawn on top of it.
    const painted = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.className || el.tagName : null;
    }, { x: menuBox.x + menuBox.width / 2, y: menuBox.y + menuBox.height / 2 });
    assert.ok(String(painted).includes("device-menu-item"),
      `the reset menu is covered or clipped — the point where it should be paints "${painted}"`);
    // Clipped to the row PLUS the space under it. A full-page shot downscales
    // the popover into nothing; an element shot clips it away entirely, because
    // it is absolutely positioned outside the row box. Neither is evidence.
    const rowBox = await sleeping.boundingBox();
    await page.screenshot({
      path: join(OUT, `${tag}-menu.png`),
      clip: {
        x: Math.max(0, rowBox.x - 8),
        y: Math.max(0, rowBox.y - 8),
        width: Math.min(viewport.width - Math.max(0, rowBox.x - 8), rowBox.width + 16),
        height: Math.min(viewport.height - Math.max(0, rowBox.y - 8), rowBox.height + menuBox.height + 40),
      },
    });
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(5, 5);

    // 8. An ordinary offline laptop is unchanged — still offline, still told to
    //    open VS Code. "We added a feature and nothing else moved."
    const laptop = row("d-laptop");
    assert.ok(/offline/i.test(await laptop.innerText()));
    const laptopTitle = await laptop.locator(".device-start").getAttribute("title");
    assert.ok(laptopTitle && /VS Code/i.test(laptopTitle),
      `a laptop keeps its old guidance: ${laptopTitle}`);

    // 6. Nothing hangs off the side of a phone.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `the picker overflows by ${overflow}px at ${viewport.width}px`);

    assert.deepEqual(errors, [], "the page must throw nothing");
    await page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
    log(`${tag}: fresh + sleeping usable, upgrade offers billing, no ✕ on cloud, laptop unchanged`);
    await ctx.close();
  }

  log(`screens in ${OUT}`);
  log("ALL CHECKS PASSED");
} finally {
  try { await browser?.close(); } catch { /* */ }
  relay.kill();
}
