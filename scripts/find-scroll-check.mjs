// Find-in-conversation must put the PHRASE on screen, not the paragraph around
// it — the one thing no vitest file can cover, because jsdom has no layout and
// therefore cannot tell "centre the block" from "centre the match".
//
// That distinction is invisible on a desk (a message body usually fits the
// viewport) and wrong on a phone (measured: a 1017px body in a 727px screen).
// The first shipped version centred the block, so stepping next/prev showed
// some hits and scrolled straight past others. 8 of 24 landed in view.
//
// Loads the REAL /chat page under Pixel-5 emulation against a mock-auth relay,
// seeds a transcript whose matches sit near the top of tall blocks, near the
// bottom of tall blocks, and inside short ones, then steps every match and
// asserts each one is actually visible. Needs dist/ built + web/vendor synced.
// Run: npm run e2e:find
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { chromium, devices } from "playwright";

const MODE = process.argv[2] || "plain";
const PORT = Number(process.env.REPRO_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[repro] ${m}`);
const NEEDLE = "zebrafish";

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, RELAY_PORT: String(PORT), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", () => {});

const waitForRelay = async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("relay never came up");
};
const postJson = async (p, b) =>
  (await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();

// A transcript long enough that the target is far off-screen. The needle sits
// early, so a correct scroll travels a long way up.
function buildMsgs() {
  const msgs = [
    { type: "clearMessages" },
    { type: "initialState", version: "find-repro", cwd: "/work/find-repro", capabilities: {} },
    { type: "setBusy", value: false },
  ];
  for (let i = 0; i < 140; i++) {
    msgs.push({ type: "userMessageChunk", text: `Question ${i}: tell me about topic ${i}\n` });
    msgs.push({ type: "promptComplete" });
    let body;
    if (i % 17 === 5) {
      // Needle near the TOP of a block taller than the screen.
      body = `Answer ${i}. The ${NEEDLE} appears here. ` + "filler ".repeat(400);
    } else if (i % 17 === 11) {
      // Needle near the BOTTOM of one.
      body = `Answer ${i}. ` + "filler ".repeat(400) + ` and then ${NEEDLE} at the end.`;
    } else if (i % 17 === 14) {
      // Needle in a SHORT block — the control that passed even when the rest failed.
      body = `Answer ${i}. Short one with ${NEEDLE} in it.`;
    } else {
      body = `Answer ${i}. ` + "filler ".repeat(40);
    }
    msgs.push({ type: "messageChunk", text: body + "\n" });
    if (MODE === "media" && i < 12 && i % 3 === 0) {
      // Images ABOVE the needle with no intrinsic size — the classic late-shift.
      msgs.push({ type: "messageChunk", text: `![shot](${BASE}/slow-image-${i}.png)\n` });
    }
    msgs.push({ type: "promptComplete" });
  }
  return msgs;
}

let browser, uplink;
try {
  await waitForRelay();
  const started = await postJson("/api/link/start", { name: "find repro host" });
  await postJson("/api/link/approve", { code: started.code });
  const token = (await postJson("/api/link/poll", { code: started.code })).token;
  assert.ok(token, "need a device token");

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((res, rej) => { uplink.once("open", res); uplink.once("error", rej); });
  let ready = 0;
  uplink.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t !== "client-ready") return;
    uplink.send(JSON.stringify({ t: "snapshot", clientId: f.clientId, msgs: buildMsgs() }));
    ready += 1;
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "find repro host" } }));

  let dev;
  for (let i = 0; i < 120 && !dev; i++) {
    const list = (await (await fetch(`${BASE}/api/devices`)).json()).devices;
    dev = list.find((d) => d.online);
    if (!dev) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(dev, "device must come online");

  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined);
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log(`pageerror: ${String(e).slice(0, 160)}`));
  const before = ready;
  await page.goto(`${BASE}/chat?device=${encodeURIComponent(dev.deviceId)}&linked=1`);
  for (let i = 0; i < 200 && ready === before; i++) await new Promise((r) => setTimeout(r, 50));
  await page.waitForTimeout(1500);

  const seam = await page.evaluate(() => !!window.__grokFind);
  log(`mode=${MODE}  seam=${seam}`);
  if (!seam) throw new Error("__grokFind missing — vendor is stale?");

  const result = await page.evaluate(async (needle) => {
    const F = window.__grokFind;
    const msgs = document.getElementById("messages");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const findEl = () => {
      const w = document.createTreeWalker(msgs, NodeFilter.SHOW_TEXT);
      let n = w.nextNode();
      while (n) { if (n.data.includes(needle)) return n.parentElement; n = w.nextNode(); }
      return null;
    };

    const vh = window.innerHeight;
    const sample = () => {
      const el = findEl();
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        scrollTop: Math.round(msgs.scrollTop),
        // How far the phrase is from the vertical centre of the viewport.
        offCentre: Math.round(r.top - vh / 2),
        inView: r.top >= 0 && r.bottom <= vh,
      };
    };

    F.open();
    await sleep(300);
    F.setQuery(needle);
    await sleep(500);
    const total = F.totalCount();

    // Step every match and record where the CURRENT one comes to rest.
    const steps = [];
    for (let k = 0; k < total; k++) {
      F.next();
      await sleep(250);
      const hl = CSS.highlights && CSS.highlights.get("grok-find-current");
      let r = null, host = null;
      if (hl) {
        for (const rng of hl) { r = rng.getBoundingClientRect(); host = rng.startContainer.parentElement; break; }
      }
      if (!r) { steps.push({ k, inView: false, noRange: true }); continue; }
      const hr = host ? host.getBoundingClientRect() : null;
      steps.push({
        k,
        matchTop: Math.round(r.top),
        inView: r.top >= 0 && r.bottom <= vh,
        blockH: hr ? Math.round(hr.height) : null,
        blockTallerThanScreen: hr ? hr.height > vh : false,
      });
    }
    return { viewportH: vh, totalMatches: total, steps };
  }, NEEDLE);

  const missed = result.steps.filter((s) => !s.inView);
  const tall = result.steps.filter((s) => s.blockTallerThanScreen);
  log(`viewport ${result.viewportH}px · ${result.totalMatches} matches · ${tall.length} inside blocks taller than the screen`);
  for (const s of missed) log(`  MISS k=${s.k} matchTop=${s.matchTop} blockH=${s.blockH}`);
  assert.equal(result.totalMatches > 0, true, "the seeded transcript must produce matches");
  assert.equal(tall.length > 0, true, "the fixture must include blocks taller than the viewport, or it proves nothing");
  assert.deepEqual(missed, [], `${missed.length}/${result.steps.length} matches landed off-screen`);
  log("ALL CHECKS PASSED — every match centred in the viewport");
} finally {
  if (browser) await browser.close();
  if (uplink) uplink.close();
  relay.kill();
}
