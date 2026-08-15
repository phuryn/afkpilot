// Touch-affordance check for the browser client — the one thing no vitest file
// can cover, because the answer lives in a CSS cascade: the vendored chat.css
// (the extension's, re-copied by `npm run sync-ui`) followed by web/chat.html's
// override block. A phone reaches the message Copy button only if that cascade
// resolves the way chat.html assumes, and every re-sync can silently move it.
//
// Loads the REAL /chat page under Pixel-5 emulation (hover:none + coarse
// pointer), then drives the tap-to-reveal shim on a synthetic DOM mirroring
// what chat.js builds. No Clerk/Supabase credentials needed — mock auth is
// fine, this is about pixels, not sessions. Needs dist/ built + web/vendor
// synced. Run: npm run e2e:touch
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { chromium, devices } from "playwright";

const PORT = Number(process.env.TOUCH_CHECK_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[touch] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
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

const postJson = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
};

let browser, uplink;
try {
  await waitForRelay();

  // Keep every /chat page attached to a real relay device. A made-up id gets
  // its /client socket closed almost immediately, after which the blocking
  // auth overlay makes every real touch assertion a race against that close.
  const started = await postJson("/api/link/start", { name: "touch UI host" });
  assert.ok(started.code, "link/start must issue a code");
  const approved = await postJson("/api/link/approve", { code: started.code });
  assert.equal(approved.ok, true, `link/approve failed: ${JSON.stringify(approved)}`);
  const token = (await postJson("/api/link/poll", { code: started.code })).token;
  assert.ok(token, "link/poll must hand back a device token");

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    uplink.once("open", resolve);
    uplink.once("error", reject);
  });
  let clientReadyCount = 0;
  uplink.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.t !== "client-ready") return;
    uplink.send(JSON.stringify({
      t: "snapshot",
      clientId: frame.clientId,
      msgs: [
        { type: "clearMessages" },
        {
          type: "initialState",
          version: "touch-check",
          cwd: "/work/touch-check",
          capabilities: { remoteVoice: true },
        },
        { type: "setBusy", value: false },
      ],
    }));
    clientReadyCount += 1;
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "touch UI host" } }));

  let linkedDevice;
  for (let i = 0; i < 100 && !linkedDevice; i++) {
    const devicesList = (await (await fetch(`${BASE}/api/devices`)).json()).devices;
    linkedDevice = devicesList.length === 1 && devicesList[0].online ? devicesList[0] : undefined;
    if (!linkedDevice) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(linkedDevice, "the touch uplink must register as one online device");
  const deviceId = linkedDevice.deviceId;
  log(`linked live test device ${deviceId}`);

  const waitForNextClientReady = async (previousCount) => {
    for (let i = 0; i < 200 && clientReadyCount === previousCount; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(clientReadyCount > previousCount, "the fake host must receive client-ready from the chat page");
  };

  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await ctx.newPage();
  // chat.js's Copy handler hits the clipboard, which headless Chromium denies —
  // that one rejection is expected noise. EVERY other page error is a failure:
  // chat.js wires the top-bar controls unconditionally at boot, so a getHtml()
  // element that web/chat.html hasn't mirrored throws on `.onclick` of null and
  // kills the whole client. That is the exact way a sync-ui silently breaks the
  // phone, so it has to turn the suite red rather than print a line.
  const bootErrors = [];
  page.on("pageerror", (e) => {
    const text = String(e);
    if (/Clipboard|clipboard/.test(text)) return;
    bootErrors.push(text);
    log(`pageerror: ${text.slice(0, 200)}`);
  });
  let previousClientReadyCount = clientReadyCount;
  await page.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`);
  await waitForNextClientReady(previousClientReadyCount);
  await page.waitForTimeout(300); // let chat.js finish wiring before judging
  assert.deepEqual(bootErrors, [], `chat.js must boot clean — likely a getHtml() element missing from web/chat.html`);
  log("chat.js booted with no page errors");

  // Remote voice is additive. The relay page may expose it only after the host
  // proves support, and the AudioWorklet module URL must be deployable beside
  // the generated chat.js rather than relying on a developer's sibling tree.
  const micButton = page.locator("#mic-btn");
  await micButton.waitFor({ state: "visible" });
  assert.equal(await micButton.isEnabled(), true, "a capable host in Chromium must get an enabled mic button");
  const workletResponse = await page.request.get(`${BASE}/vendor/media/pcm-worklet.js`);
  assert.equal(workletResponse.status(), 200, "the PCM AudioWorklet URL loaded by chat.js must not 404");
  assert.match(
    await workletResponse.text(),
    /registerProcessor\("grok-pcm-capture"/,
    "the served worklet must register the processor chat.js requests",
  );
  const chatResponse = await page.request.get(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  assert.equal(
    chatResponse.headers()["content-security-policy"],
    undefined,
    "the relay must not add a CSP that can block the AudioWorklet module",
  );
  assert.equal(
    chatResponse.headers()["permissions-policy"],
    undefined,
    "the relay must not add a Permissions-Policy that can block microphone access",
  );
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "initialState", capabilities: {} },
  })));
  await micButton.waitFor({ state: "hidden" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "initialState", capabilities: { remoteVoice: true } },
  })));
  await micButton.waitFor({ state: "visible" });
  log("remote mic is capability-gated, visible for a capable host, and its worklet is served without blocking headers");

  // A successful device link belongs inside the transcript, not in the shared
  // blocking overlay or the quota slot above the composer. It stays until the
  // explicit close is tapped, while the live composer remains usable.
  const mobileOnboarding = page.locator("#link-onboarding");
  await mobileOnboarding.waitFor({ state: "visible" });
  assert.equal(
    await mobileOnboarding.evaluate((el) => el.parentElement?.id),
    "messages-wrap",
    "post-link onboarding must be attached to the transcript",
  );
  assert.equal(
    await mobileOnboarding.evaluate((el) => el === el.parentElement?.firstElementChild),
    true,
    "post-link onboarding must sit at the top of the transcript",
  );
  assert.match(await mobileOnboarding.innerText(), /100% remotely/);
  assert.equal(await mobileOnboarding.getByText(/Copy "afkpilot\.com"/).count(), 0, "mobile needs no domain copy action");
  assert.equal(await page.locator(".auth-overlay:visible").count(), 0, "onboarding must not reuse the blocking overlay");
  assert.equal(await page.locator("#quota-wall").count(), 0, "onboarding must not reuse the quota wall");
  assert.equal(await page.locator("#input").isEditable(), true, "onboarding must leave the composer usable");
  assert.ok(
    await mobileOnboarding.locator(".link-onboarding-close").evaluate((el) => el.getBoundingClientRect().height) >= 44,
    "the mobile close target must be at least 44px high",
  );
  assert.equal(new URL(page.url()).searchParams.has("linked"), false, "linked=1 must be stripped after onboarding");
  await mobileOnboarding.locator(".link-onboarding-close").click();
  assert.equal(await page.locator("#link-onboarding").count(), 0, "the explicit close must dismiss onboarding");
  log("post-link phone onboarding is transcript-attached, non-blocking, one-shot, and explicitly dismissible");

  // iOS has no beforeinstallprompt API. Preserve the existing fallback: the
  // install action turns into concise Share > Add to Home Screen guidance.
  const ios = await browser.newContext({ ...devices["iPhone 13"] });
  const iosPage = await ios.newPage();
  previousClientReadyCount = clientReadyCount;
  await iosPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`);
  await waitForNextClientReady(previousClientReadyCount);
  const iosOnboarding = iosPage.locator("#link-onboarding");
  await iosOnboarding.waitFor({ state: "visible" });
  await iosOnboarding.getByRole("button", { name: "Install app" }).click();
  assert.match(await iosOnboarding.innerText(), /Tap Share, then "Add to Home Screen"/);
  assert.match(await iosOnboarding.innerText(), /100% remotely/);
  assert.equal(
    await iosOnboarding.getByRole("button", { name: "Install app" }).count(),
    0,
    "iOS install action must yield to the share-sheet instructions",
  );
  await ios.close();
  log("iOS keeps the Share > Add to Home Screen install fallback");

  assert.equal(
    await page.evaluate(() => matchMedia("(hover: none)").matches),
    true,
    "Pixel 5 emulation must report (hover: none), or the shim self-disables and this file proves nothing",
  );
  log("emulation reports (hover: none) — the shim is live");

  // Exercise the active-rail CSS state explicitly: chat.js removes [hidden]
  // after a capable host publishes repos, so the phone rules must turn the rail
  // into a DRAWER — off-canvas and out of the tab order at rest, over the
  // conversation when opened, never a column stealing width from it. This is the
  // regression guard for that presentation, not a host capability test.
  const mobileRail = await page.evaluate(() => {
    const el = document.getElementById("projects-rail");
    if (!el) return { present: false };
    el.hidden = false;
    document.body.classList.add("has-rail");
    const style = getComputedStyle(el);
    return {
      present: true,
      position: style.position,
      visibility: style.visibility,
      offLeft: el.getBoundingClientRect().right <= 0,
      chatLeft: Math.round(document.getElementById("messages").getBoundingClientRect().left),
      headVisible: getComputedStyle(document.getElementById("session-head")).display !== "none",
      barHidden: getComputedStyle(document.querySelector("#app > .top-bar")).display === "none",
      width: Math.round(el.getBoundingClientRect().width),
      viewport: window.innerWidth,
      // The drag handle is a pointer affordance for a docked rail. A phone has
      // no rail edge to drag — the drawer is off-canvas — so it must not mount
      // visibly here. Guards the shared chat.css rule against the day someone
      // drops the web-only breakpoint override.
      resizerShown: (() => {
        const r = document.getElementById("rail-resizer");
        return !!r && getComputedStyle(r).display !== "none";
      })(),
    };
  });
  assert.equal(mobileRail.present, true, "the remote page must carry the rail mount");
  assert.equal(mobileRail.position, "fixed", "the phone rail must be a drawer, not a column");
  assert.equal(mobileRail.visibility, "hidden", "a closed drawer must be out of the tab order");
  assert.equal(mobileRail.offLeft, true, "the closed drawer must sit off-canvas");
  assert.equal(mobileRail.chatLeft, 0, "the drawer must steal no width from the conversation");
  assert.equal(mobileRail.resizerShown, false, "a phone drawer must not offer a drag handle");
  // A drawer covers most of the screen; a narrow strip is the signature of the
  // DOCKED width (a fraction of the viewport) leaking onto the phone through
  // the cascade — chat.css is loaded AFTER this page's own <style>, so any rail
  // rule they share at equal specificity is won by the vendored file.
  assert.ok(
    mobileRail.width >= mobileRail.viewport * 0.66,
    `the drawer must cover most of the screen, got ${mobileRail.width}px of ${mobileRail.viewport}px`,
  );
  // With a rail, the app-wide bar gives way to the conversation's own header —
  // the same component the desktop shows, plus the drawer handle.
  assert.equal(mobileRail.headVisible, true, "the conversation header replaces the top bar");
  assert.equal(mobileRail.barHidden, true, "the app-wide top bar gives way to it");

  // The handle opens it, the scrim closes it. Both are how a phone reaches the
  // projects list at all, so neither may be hover-dependent.
  await page.evaluate(() => document.getElementById("rail-open").click());
  const opened = await page.evaluate(() => ({
    open: document.body.classList.contains("rail-open"),
    visibility: getComputedStyle(document.getElementById("projects-rail")).visibility,
    scrim: !document.getElementById("rail-scrim").hidden,
  }));
  assert.equal(opened.open, true, "the handle must open the drawer");
  assert.equal(opened.visibility, "visible", "an open drawer must be reachable");
  assert.equal(opened.scrim, true, "an open drawer must dim what it covers");
  await page.evaluate(() => document.getElementById("rail-scrim").click());
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("rail-open")),
    false,
    "tapping outside must close the drawer",
  );
  log("the projects rail is a drawer on phones: off-canvas at rest, handle opens, scrim closes");

  // The remote add menu uses separate, explicit photo/document rows. The
  // document row is absent until an exact host capability arrives, and both
  // rows meet a phone-sized tap target once enabled.
  await page.evaluate(() => document.getElementById("add-btn").click());
  assert.equal(
    await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" }).count(),
    0,
    "document upload must be hidden before capability proof",
  );
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "initialState", capabilities: { uploadFile: true } },
  })));
  const uploadRows = page.locator("#add-popover .remote-upload-item");
  await uploadRows.filter({ hasText: "Add document" }).waitFor({ state: "visible" });
  assert.deepEqual(
    await uploadRows.allTextContents(),
    ["Add photo", "Add document"],
    "the phone must tell users whether they are choosing pixels or a document",
  );
  for (const height of await uploadRows.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) {
    assert.ok(height >= 44, `upload row tap target must be at least 44px high (was ${height}px)`);
  }
  // Close it the way a user does. Setting .hidden directly leaves chat.js
  // believing a popover is still open, and its outside-click handler then eats
  // the next tap — which silently breaks every footer-reveal assertion below.
  await page.evaluate(() => document.getElementById("add-btn").click());
  await page.locator("#add-popover").waitFor({ state: "hidden" });
  log("photo/document rows are capability-gated, explicit, and at least 44px tall");

  // An uploaded document carries its REAL filename, which on a phone is routinely
  // wider than the chip. The label ellipsizes and the remove button is fixed, so
  // before .attachment > svg got flex:0 0 auto the icon was the only child able
  // to absorb the overflow and collapsed to ~6px — visible only on mobile, which
  // is why a desktop-only check would never have caught it.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "chips", chips: [
      { id: "image:/a/x.png:1:1", path: "/a/x.png", relPath: "Image #1", hidden: false, imageIndex: 1, mimeType: "image/png" },
      { id: "explicit:/a/long.pdf:0-0:2", path: "/a/long.pdf", hidden: false,
        relPath: "154505200008003_XVI_C_405_21_20260724_id72666935_220_polecenie_wyplaty.pdf" },
    ] },
  })));
  const iconSizes = await page.locator("#attachments .attachment svg")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  assert.equal(iconSizes.length, 2, "both chips must render");
  for (const w of iconSizes) {
    assert.equal(w, 11, `attachment icon must stay 11px even when the filename overflows (was ${w}px)`);
  }
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "chips", chips: [] } })));
  log("a long filename ellipsizes the label instead of crushing the chip icon");

  // Mirror what chat.js builds: a finished agent turn (footer revealed at
  // agentEnd), a still-streaming one (footer carries [hidden]), a user bubble,
  // and a generated image nested inside the finished agent bubble.
  await page.evaluate(() => {
    const m = document.getElementById("messages");
    m.innerHTML = "";
    const mk = (cls, id, hidden) => {
      const el = document.createElement("div");
      el.className = `msg ${cls}`;
      el.id = id;
      const a = document.createElement("div");
      a.className = "msg-actions";
      if (hidden) a.hidden = true;
      const b = document.createElement("button");
      b.className = "msg-action-btn msg-copy-btn";
      b.textContent = "copy";
      a.appendChild(b);
      el.appendChild(a);
      m.appendChild(el);
      return el;
    };
    mk("agent", "done", false);
    mk("agent", "streaming", true);
    mk("user", "usermsg", false);
    const img = document.createElement("div");
    img.className = "generated-image";
    img.id = "img";
    const overlay = document.createElement("div");
    overlay.className = "generated-media-actions";
    img.appendChild(overlay);
    document.getElementById("done").appendChild(img);
  });

  const styleOf = (sel) =>
    page.evaluate((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents, display: cs.display };
    }, sel);
  // .msg-actions carries `transition: opacity 0.12s`, so a read taken mid-flight
  // returns a fraction and the assertion fails at random — a fixed 250ms wait
  // only made that rare, and it still flaked on a loaded machine.
  //
  // Poll for the EXPECTED value rather than for "settled": opacity 0 is both the
  // resting state and the first frame of a 0->1 reveal, so nothing read from the
  // element alone can distinguish "finished hidden" from "about to appear". Only
  // the expectation disambiguates them. A wrong value now fails by timeout, and
  // the catch re-reads so the message still names what it actually saw.
  const expectOpacity = async (target, sel, expected, msg) => {
    try {
      await target.waitForFunction(
        ({ s, e }) => {
          const el = document.querySelector(s);
          return !!el && getComputedStyle(el).opacity === e;
        },
        { s: sel, e: expected },
        { timeout: 3000 },
      );
    } catch {
      const actual = await target.evaluate((s) => getComputedStyle(document.querySelector(s)).opacity, sel);
      assert.fail(`${msg} — opacity was ${actual}, expected ${expected}`);
    }
  };
  const hasReveal = (sel) => page.evaluate((s) => document.querySelector(s).classList.contains("show-actions"), sel);
  // A real DOM click, so it bubbles to the document-level shim without fighting
  // the signed-out overlay for hit-testing. The class toggle is synchronous with
  // the click; styleOf does the waiting for anything that transitions.
  const tap = async (sel) => {
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };

  // 1. Dimmed and tappable at rest (owner, 2026-08-13). The footer's resting
  //    state on touch is the vendored 0.4 — visible enough to find, quiet
  //    enough to ignore — and its controls take taps with NO reveal gesture
  //    first. This replaced the old hide/tap-to-reveal shim for message
  //    footers; if either assertion fails, a chat.html rule is fighting the
  //    vendored contract again.
  for (const id of ["#done", "#usermsg"]) {
    await expectOpacity(page, `${id} .msg-actions`, "0.4", `${id} footer rests dimmed`);
    assert.equal((await styleOf(`${id} .msg-actions`)).pointerEvents, "auto", `${id} footer is tappable at rest`);
  }
  assert.equal((await styleOf("#streaming .msg-actions")).display, "none", "streaming footer is display:none");
  log("footers rest dimmed and tappable; the streaming one is display:none");

  // 2. A tap must never surface a footer the extension hid mid-turn — [hidden]
  //    -> display:none outranks every opacity rule involved.
  await tap("#streaming");
  assert.equal((await styleOf("#streaming .msg-actions")).display, "none", "[hidden] beats any reveal");
  log("tapping a streaming bubble cannot surface its unfinished footer");

  // 3. Copy takes a direct tap — no reveal gesture first, and the tap must not
  //    collapse or disable the footer under the finger.
  await tap("#usermsg .msg-copy-btn");
  assert.equal((await styleOf("#usermsg .msg-actions")).pointerEvents, "auto", "footer still tappable after Copy");
  log("Copy takes a direct tap with no reveal gesture");

  // A tap leaves a STICKY :hover under touch, so a footer near the tap may sit
  // at the hover-brightened 1 rather than the resting 0.4 — both are fine; the
  // claim worth pinning is "visible and tappable", never a return to hidden.
  const expectFooterVisible = async (sel, msg) => {
    const s = await styleOf(sel);
    assert.ok(parseFloat(s.opacity) >= 0.39, `${msg} — opacity was ${s.opacity}`);
    assert.equal(s.pointerEvents, "auto", `${msg} — pointer-events was ${s.pointerEvents}`);
  };

  // 4. Media tap-to-reveal is scoped to the media: the reveal class lands on
  //    the image only, and the containing bubble's footer stays visible.
  await tap("#img");
  assert.equal(await hasReveal("#img"), true, "the image took the tap");
  assert.equal(await hasReveal("#done"), false, "the containing bubble did not");
  await expectFooterVisible("#done .msg-actions", "bubble footer stays visible");
  log("media reveal stays scoped to the media");

  // 5. Tapping neutral chrome clears media reveals; footers stay visible.
  await tap("#messages");
  await expectFooterVisible("#usermsg .msg-actions", "footers stay visible");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".show-actions").length), 0);
  assert.equal(
    await page.locator(".auth-overlay:visible").count(),
    0,
    "the live device must keep the blocking overlay absent for the whole touch sequence",
  );
  log("tapping elsewhere clears every reveal");

  // 6. Hover-capable clients are untouched: the shim self-disables, and the
  //    vendored hover/focus brighten (0.4 → 1) still works on top of the
  //    dimmed rest.
  const desk = await browser.newContext();
  await desk.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text) {
          window.__copiedOnboardingText = text;
          return Promise.resolve();
        },
      },
    });
  });
  const dpage = await desk.newPage();
  previousClientReadyCount = clientReadyCount;
  await dpage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`);
  await waitForNextClientReady(previousClientReadyCount);
  const desktopOnboarding = dpage.locator("#link-onboarding");
  await desktopOnboarding.waitFor({ state: "visible" });
  assert.match(await desktopOnboarding.innerText(), /You can also open afkpilot\.com on your phone/);
  assert.match(await desktopOnboarding.innerText(), /100% remotely/);
  const domainCopy = desktopOnboarding.locator(".link-onboarding-copy-btn");
  await domainCopy.click();
  assert.equal(
    await dpage.evaluate(() => window.__copiedOnboardingText),
    "afkpilot.com",
    "desktop copy must write the bare production domain",
  );
  assert.equal(await domainCopy.locator("span").innerText(), "Copied", "copy success must be visible");
  await desktopOnboarding.locator(".link-onboarding-close").click();
  assert.equal(await dpage.locator("#link-onboarding").count(), 0);
  log("desktop onboarding copies the bare domain and shows success without blocking chat");

  // The extension's "Continue remotely" URL starts at / because it does not
  // know the device id. A one-device account must skip the picker without even
  // flashing it, preserve the hint through the redirect, and let /chat consume
  // that hint by showing this same banner.
  const single = await browser.newContext({ ...devices["Pixel 5"] });
  const singlePage = await single.newPage();
  await singlePage.route("**/api/devices", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices: [{
          deviceId,
          name: "Only workspace",
          createdAt: Date.now(),
          online: true,
          clients: 0,
        }],
      }),
    });
  });
  previousClientReadyCount = clientReadyCount;
  await singlePage.goto(`${BASE}/?remoteHint=1`);
  assert.equal(
    await singlePage.locator("#picker").isHidden(),
    true,
    "the picker must remain hidden while a one-device account is resolved",
  );
  await singlePage.waitForURL((url) => url.pathname === "/chat" && url.searchParams.get("device") === deviceId);
  await waitForNextClientReady(previousClientReadyCount);
  await singlePage.locator("#link-onboarding").waitFor({ state: "visible" });
  assert.equal(
    new URL(singlePage.url()).searchParams.has("remoteHint"),
    false,
    "chat must consume remoteHint=1 after showing onboarding",
  );
  await single.close();

  const linkedForward = await browser.newContext({ ...devices["Pixel 5"] });
  await linkedForward.route("**/api/devices", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices: [{
          deviceId,
          name: "Only workspace",
          createdAt: Date.now(),
          online: true,
          clients: 0,
        }],
      }),
    });
  });
  const linkedForwardPage = await linkedForward.newPage();
  previousClientReadyCount = clientReadyCount;
  await linkedForwardPage.goto(`${BASE}/?linked=1`);
  await linkedForwardPage.waitForURL((url) => url.pathname === "/chat" && url.searchParams.get("device") === deviceId);
  await waitForNextClientReady(previousClientReadyCount);
  await linkedForwardPage.locator("#link-onboarding").waitFor({ state: "visible" });
  assert.equal(
    new URL(linkedForwardPage.url()).searchParams.has("linked"),
    false,
    "the one-device redirect must also carry linked=1 for chat to consume",
  );
  await linkedForward.close();
  log("one-device redirects carry remoteHint=1 or linked=1 into the shared chat banner");

  // A one-device account is also the normal free-tier account page. Without an
  // explicit entry-point hint it must remain available for usage and device
  // management instead of treating device count alone as navigation intent.
  const organicSingle = await browser.newContext({ ...devices["Pixel 5"] });
  await organicSingle.route("**/api/devices", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          { deviceId: "organic-device", name: "My workspace", createdAt: 1, online: true, clients: 0 },
        ],
      }),
    });
  });
  const organicSinglePage = await organicSingle.newPage();
  await organicSinglePage.goto(`${BASE}/`);
  await organicSinglePage.locator("#picker").waitFor({ state: "visible" });
  assert.equal(await organicSinglePage.locator("#list .device-row").count(), 1);
  assert.equal(new URL(organicSinglePage.url()).pathname, "/", "an organic one-device visit must stay on the picker");
  await organicSingle.close();
  log("a one-device account remains manageable on an organic picker visit");

  // Reproduce the polling regression: the account starts with two devices,
  // then the next real 3-second refresh observes only one. With no hint in the
  // URL, the row should update in place and the page must not jump into chat.
  const shrinking = await browser.newContext({ ...devices["Pixel 5"] });
  let devicePolls = 0;
  await shrinking.route("**/api/devices", async (route) => {
    devicePolls += 1;
    const listed = devicePolls === 1
      ? [
          { deviceId: "device-a", name: "Workspace A", createdAt: 1, online: true, clients: 0 },
          { deviceId: "device-b", name: "Workspace B", createdAt: 2, online: false, clients: 0 },
        ]
      : [
          { deviceId: "device-a", name: "Workspace A", createdAt: 1, online: true, clients: 0 },
        ];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ devices: listed }),
    });
  });
  const shrinkingPage = await shrinking.newPage();
  await shrinkingPage.goto(`${BASE}/`);
  await shrinkingPage.locator("#picker").waitFor({ state: "visible" });
  assert.equal(await shrinkingPage.locator("#list .device-row").count(), 2);
  await shrinkingPage.waitForFunction(
    () => document.querySelectorAll("#list .device-row").length === 1,
    undefined,
    { timeout: 5000 },
  );
  assert.ok(devicePolls >= 2, "the device list must have crossed a real refresh tick");
  assert.equal(new URL(shrinkingPage.url()).pathname, "/", "a no-hint 2-to-1 poll must stay on the picker");
  await shrinking.close();
  log("a no-hint device list shrinking from two to one stays on the picker");

  // Multiple devices remain an explicit choice. Once the user picks an online
  // workspace, carry the extension's hint into /chat so the shared onboarding
  // banner appears there too.
  const multiple = await browser.newContext({ ...devices["Pixel 5"] });
  const multiplePage = await multiple.newPage();
  await multiplePage.route("**/api/devices", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          { deviceId, name: "Workspace A", createdAt: 1, online: true, clients: 0 },
          { deviceId: "device-b", name: "Workspace B", createdAt: 2, online: false, clients: 0 },
        ],
      }),
    });
  });
  await multiplePage.goto(`${BASE}/?remoteHint=1`);
  await multiplePage.locator("#picker").waitFor({ state: "visible" });
  assert.equal(await multiplePage.locator("#list .device-row").count(), 2);
  assert.equal(new URL(multiplePage.url()).pathname, "/", "multi-device accounts must stay on the picker");
  assert.equal(
    await multiplePage.locator('#list .device-row[data-online="false"] a').count(),
    0,
    "offline picker rows must remain non-links",
  );
  previousClientReadyCount = clientReadyCount;
  const [selectedPage] = await Promise.all([
    multiple.waitForEvent("page"),
    multiplePage.locator('#list .device-row[data-online="true"] a').click(),
  ]);
  await waitForNextClientReady(previousClientReadyCount);
  await selectedPage.locator("#link-onboarding").waitFor({ state: "visible" });
  assert.equal(
    new URL(selectedPage.url()).searchParams.get("device"),
    deviceId,
    "the selected picker device must reach chat",
  );
  assert.equal(
    new URL(selectedPage.url()).searchParams.has("remoteHint"),
    false,
    "chat must consume the picker-carried remoteHint=1 after showing onboarding",
  );
  await multiple.close();
  log("remoteHint=1 stays on the multi-device picker until selection, then opens chat onboarding");

  await dpage.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".auth-overlay { display: none !important; }";
    document.head.appendChild(style);
    // Real hover needs real hit-testing — the signed-out overlay would eat it.
    document.querySelectorAll(".auth-overlay").forEach((el) => el.remove());
    document.getElementById("messages").innerHTML =
      '<div class="msg agent" id="d"><div class="msg-actions"><button class="msg-action-btn">c</button></div></div>';
  });
  assert.equal(await dpage.evaluate(() => matchMedia("(hover: none)").matches), false);
  assert.equal(
    await dpage.evaluate(() => getComputedStyle(document.querySelector("#d .msg-actions")).pointerEvents),
    "auto",
    "desktop footers stay clickable — the touch block must not leak",
  );
  await dpage.hover("#d");
  // same 0.12s transition, same fix
  await expectOpacity(dpage, "#d .msg-actions", "1", "hover reveals the desktop footer");
  log("hover-capable clients keep the vendored hover behavior, unchanged");

  console.log("[touch] ALL CHECKS PASSED");
} finally {
  if (browser) await browser.close();
  if (uplink) try { uplink.close(); } catch { /* best effort */ }
  relay.kill();
}
