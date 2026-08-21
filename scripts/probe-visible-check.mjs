// TEMPORARY: prove the ?scrolldebug=1 panel is actually visible and usable on a
// phone viewport. Written because the owner asked, correctly, whether the COPY
// button he is meant to tap can be seen at all. Delete with the probe.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const PORT = Number(process.env.PROBE_CHECK_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[probe] ${m}`);

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, RELAY_PORT: String(PORT), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", () => {});

let browser;
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined);
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/chat?device=probe-device&scrolldebug=1`);
  await page.waitForTimeout(1200);

  const copy = page.locator("text=COPY").first();
  assert.ok(await copy.count(), "COPY button must exist");
  assert.ok(await copy.isVisible(), "COPY button must be visible");
  const box = await copy.boundingBox();
  assert.ok(box, "COPY button must have a box");
  const vp = page.viewportSize();
  log(`viewport ${vp.width}x${vp.height}, COPY at x=${Math.round(box.x)} y=${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
  assert.ok(box.y >= 0 && box.y + box.height <= vp.height, "COPY must be inside the viewport");
  assert.ok(box.width >= 40 && box.height >= 20, "COPY must be big enough to tap");

  // it must not be under anything
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.textContent || "").slice(0, 20) : "none";
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  log(`element at the COPY centre: "${hit}"`);
  assert.ok(/COPY/.test(hit), "COPY must be the topmost element at its own centre");

  await page.screenshot({ path: ".screens/probe-panel.png" });
  log("screenshot .screens/probe-panel.png");
  log("ALL CHECKS PASSED");
} finally {
  if (browser) await browser.close();
  relay.kill();
}
