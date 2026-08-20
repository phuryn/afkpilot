// Legacy-host compatibility check — the relay ships a web client that can be
// NEWER than the extension a user has installed, and there is no version
// negotiation on the wire (REMOTE_PROTO_VERSION only moves on an INCOMPATIBLE
// change; the repo switcher was deliberately additive). So the contract is:
// every relay release must stay usable against the last published extension.
//
// This drives the REAL /chat page against a host that speaks ONLY the v2.0.4
// message set — it never sends `repos`, and it drops any inbound type v2.0.4's
// WEBVIEW_MESSAGE_TYPE_MAP didn't carry, exactly as the shipped policy gate
// does.
//
// Since the 3.1.0 floor, a host that *identifies* as v2.0.4 (initialState.extVersion)
// must produce the update-your-extension notice rather than a usable chat. The
// rest of the file then raises the advertised version to 3.1.0 while still
// speaking only the old message set, so the degradation paths stay covered
// until the gate has proven itself and those paths can be deleted.
//
// No Clerk/Supabase credentials needed — mock auth is the point of the keyless
// dev mode. Needs dist/ built + web/vendor synced. Run: npm run e2e:legacy
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { chromium, devices } from "playwright";

const PORT = Number(process.env.LEGACY_CHECK_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[legacy] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

// Frozen fixture: `git show v2.0.4:src/protocol.ts`. This is a historical
// contract — it cannot drift, and hardcoding it keeps the check independent of
// whether the sibling extension checkout exists.
const V2_0_4_WEBVIEW_TYPES = new Set([
  "ready", "send", "newSession", "cancel", "pickModel", "setMode", "removeChip", "toggleChip",
  "openFile", "openUrl", "openDiff", "exportExpr", "setEffort", "openGlobalConfig",
  "openProjectConfig", "runMcpList", "showLogs", "moveView", "setShowThinking",
  "setExpandCommandOutputs", "setSteerByDefault", "setSoundNotifications", "dropFile",
  "permissionAnswer", "exitPlanAnswer", "questionAnswer", "questionCancel", "setModel",
  "runInstallCmd", "runGrokLogin", "logout", "checkGrokUpdate", "updateGrok",
  "recheckConnection", "listSessions", "resumeSession", "renameSession", "deleteSession",
  "clearAllSessions", "pickFile", "mentionQuery", "addMentionFile", "pasteImage", "voiceStart",
  "voiceStop", "queueSend", "dequeueSend", "clearQueuedSends", "steerSend", "forkSession",
  "newWorktreeSession", "applyWorktree", "removeWorktree", "rewindSession", "editLastMessage",
  "uiConfirmAnswer", "workflowControl", "remoteSignIn", "remoteSignOut", "openRemotePortal",
]);
// These existed in v2.0.4's protocol but its remote policy classified them
// host-local. A browser client must reinterpret the upload gesture rather than
// send either message into a gate that can only drop it.
const V2_0_4_REMOTE_HOST_LOCAL_TYPES = new Set(["pickFile", "dropFile"]);
let uploadFileCapableHost = false;
let omitInitialStateForNextClient = false;

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, RELAY_PORT: String(PORT), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" },
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

const postJson = async (p, body) =>
  (await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();

let browser, uplink;
try {
  await waitForRelay();

  // ---- 1. Link exactly the way v2.0.4 does: {name} with NO installId. -------
  // The relink dedupe added install_id to this payload; an older extension
  // simply omits it, and must still be able to link at all.
  const started = await postJson("/api/link/start", { name: "legacy box (v2.0.4)" });
  assert.ok(started.code, "link/start must issue a code for a payload with no installId");
  const approved = await postJson("/api/link/approve", { code: started.code });
  assert.equal(approved.ok, true, `link/approve failed: ${JSON.stringify(approved)}`);
  const token = (await postJson("/api/link/poll", { code: started.code })).token;
  assert.ok(token, "poll must hand back a device token");
  log("an installId-less /api/link/start still links — old extensions can pair");

  // ---- 2. The legacy host: v2.0.4's message set, and no `repos` frame. ------
  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((res, rej) => {
    uplink.once("open", res);
    uplink.once("error", rej);
  });
  // Advertised extension version on initialState. Real hosts send `extVersion`
  // (not `version`). Start at 2.0.4 so the first page load exercises the floor;
  // the degradation suite below then lifts this to 3.1.0.
  let hostExtVersion = "2.0.4";
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "legacy box (v2.0.4)" } }));

  const received = [];
  const dropped = [];
  const wireEvents = [];
  let clientReadyCount = 0;
  const send = (msg) => uplink.send(JSON.stringify({ t: "host", msg }));
  uplink.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === "client-ready") {
      clientReadyCount += 1;
      wireEvents.push({ type: "client-ready", clientId: f.clientId });
      const omitInitialState = omitInitialStateForNextClient;
      omitInitialStateForNextClient = false;
      // v2.0.4's snapshot: chrome the webview needs, and NOTHING repo-shaped.
      uplink.send(JSON.stringify({
        t: "snapshot",
        clientId: f.clientId,
        msgs: [
          { type: "clearMessages" },
          ...(!omitInitialState ? [{
            type: "initialState",
            extVersion: hostExtVersion,
            // A reconnect has a fresh clientId and therefore starts in the
            // host's default workspace. This is the real failure shape the
            // browser outbox must recover from before sending queued work.
            // Counts 1 (gate page) and 2 (first usable chat) are the home
            // workspace; later clientIds are reconnects/new tabs.
            cwd: clientReadyCount <= 2 ? "/work/legacy" : "/work/default",
            capabilities: uploadFileCapableHost ? { uploadFile: true, remoteVoice: true } : undefined,
          }] : []),
          { type: "setBusy", value: false },
        ],
      }));
      return;
    }
    if (f.t !== "msg") return;
    const m = f.msg;
    // The shipped gate: unknown and host-local types never reach onMessage.
    if (
      (!V2_0_4_WEBVIEW_TYPES.has(m.type) &&
        !(uploadFileCapableHost && (
          m.type === "uploadFile" ||
          m.type === "selectRepo" ||
          m.type === "remoteVoiceStart" ||
          m.type === "remoteVoiceChunk" ||
          m.type === "remoteVoiceStop"
        ))) ||
      V2_0_4_REMOTE_HOST_LOCAL_TYPES.has(m.type)
    ) {
      dropped.push(m);
      return;
    }
    received.push(m);
    wireEvents.push({ type: m.type, text: m.text, cwd: m.cwd, id: m.id });
    if (m.type === "listSessions") {
      send({
        type: "sessions",
        entries: [{ id: "s1", displayName: "an older chat", updatedAt: 1, cwd: "/work/legacy" }],
        activeId: "s1", dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
      });
    } else if (uploadFileCapableHost && m.type === "selectRepo") {
      setTimeout(() => {
        send({
          type: "repos",
          entries: [{ cwd: "/work/legacy", label: "legacy", available: true, pinned: false, updatedAt: 1 }],
          selectedCwd: "/work/legacy",
          activeCwd: "/work/legacy",
        });
        // A real repo selection is followed by the selected repo's newest-first
        // sessions page. The remembered tab session is deliberately not first:
        // restore must not reinterpret selectRepo as a row click and resume s2.
        send({
          type: "sessions",
          entries: [
            { id: "s2", displayName: "newest chat", updatedAt: 2, cwd: "/work/legacy" },
            { id: "s1", displayName: "remembered chat", updatedAt: 1, cwd: "/work/legacy" },
          ],
          activeId: null, dots: {}, offset: 0, total: 2, hasMore: false, nextOffset: 2, query: "",
        });
      }, 100);
    } else if (uploadFileCapableHost && m.type === "resumeSession") {
      // Deliberately slow confirmation: queued work must remain held after the
      // browser has sent restore commands, until the host proves they applied.
      setTimeout(() => send({
        type: "sessions",
        entries: [{ id: "s1", displayName: "an older chat", updatedAt: 1, cwd: "/work/legacy" }],
        activeId: "s1", dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
      }), 800);
    }
  });

  const devicesList = (await (await fetch(`${BASE}/api/devices`)).json()).devices;
  assert.equal(devicesList.length, 1, "the legacy uplink must register as a device");
  const deviceId = devicesList[0].deviceId;

  // ---- 3. Drive the real page, on a phone, against that host. ---------------
  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });

  const attachSocketSpy = async (target) => {
    await target.addInitScript(() => {
      window.__grokDeviceOfflineGraceMs = 250;
      window.__grokIdentityRestoreTimeoutMs = 250;
      const NativeWebSocket = window.WebSocket;
      window.__legacyTestSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__legacyTestSockets.push(this);
        }
      };
    });
  };

  // ---- 3a. A v2.0.4 host must produce the update notice, not a dead chat. ---
  const gatePage = await ctx.newPage();
  await attachSocketSpy(gatePage);
  const gateErrors = [];
  gatePage.on("pageerror", (e) => {
    if (/Clipboard|clipboard/.test(String(e))) return;
    gateErrors.push(String(e));
    log(`gate pageerror: ${String(e).slice(0, 200)}`);
  });
  await gatePage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await gatePage.locator("#host-too-old").waitFor({ state: "visible", timeout: 20000 });
  const gate = await gatePage.evaluate(() => {
    const notice = document.getElementById("host-too-old");
    const app = document.getElementById("app");
    return {
      noticeHidden: notice?.hidden,
      copy: document.getElementById("host-too-old-copy")?.textContent || "",
      appHidden: !!app?.hidden,
      appDisplay: app ? getComputedStyle(app).display : "",
    };
  });
  assert.equal(gate.noticeHidden, false, "the update notice must be visible");
  assert.match(gate.copy, /Update the Grok Build extension on your computer to use remote control/);
  assert.match(gate.copy, /v2\.0\.4/, "the notice must name the installed version");
  assert.equal(gate.appHidden, true, "the chat UI must be hidden behind the notice");
  assert.equal(gate.appDisplay, "none", "a hidden #app must occupy no layout");
  assert.deepEqual(gateErrors, [], "the update notice must not crash");
  assert.deepEqual(
    dropped.map((m) => m.type),
    [],
    `the gated page must not send types a v2.0.4 host would drop: ${JSON.stringify(dropped.map((m) => m.type))}`,
  );
  await gatePage.close();
  log("a v2.0.4 host produces the update-your-extension notice — no dead controls");

  // The degradation paths stay until the gate has proven itself. Raise the
  // advertised version so this host is allowed through, while still speaking
  // only the v2.0.4 message set (no `repos`).
  hostExtVersion = "3.1.0";

  const page = await ctx.newPage();
  await attachSocketSpy(page);
  const bootErrors = [];
  page.on("pageerror", (e) => {
    if (/Clipboard|clipboard/.test(String(e))) return;
    bootErrors.push(String(e));
    log(`pageerror: ${String(e).slice(0, 200)}`);
  });
  await page.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await page.waitForFunction(() => !document.getElementById("send-btn")?.disabled, null, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  assert.deepEqual(bootErrors, [], "chat.js must boot clean against a host that never sends `repos`");
  log("the page boots clean against a host that never sends `repos`");

  // The whole point: no dead chip. Hidden AND not merely transparent.
  const chip = await page.evaluate(() => {
    const el = document.getElementById("repo-btn");
    return { present: !!el, hidden: el?.hidden, display: getComputedStyle(el).display, box: el.getBoundingClientRect().width };
  });
  assert.equal(chip.present, true, "the element must still exist — chat.js wires it unconditionally");
  assert.equal(chip.hidden, true, "the repo chip must be [hidden] with no `repos` frame");
  assert.equal(chip.display, "none", "`.repo-chip[hidden]` must beat the author display:inline-flex");
  assert.equal(chip.box, 0, "a hidden chip must occupy no space in the top bar");
  log("the repo switcher hides itself instead of rendering an empty dead control");

  // The projects rail uses the same capability proof as the old chip. The
  // mount is present for the shared client, but an old host never sends `repos`,
  // so it must remain hidden and leave the legacy single-column layout intact.
  const rail = await page.evaluate(() => {
    const el = document.getElementById("projects-rail");
    return {
      present: !!el,
      hidden: el?.hidden,
      display: el ? getComputedStyle(el).display : "",
      box: el?.getBoundingClientRect().width,
    };
  });
  assert.equal(rail.present, true, "the rail mount must be present for the remote client");
  assert.equal(rail.hidden, true, "the rail must stay hidden with no `repos` frame");
  assert.equal(rail.display, "none", "a legacy host must not get an empty projects rail");
  assert.equal(rail.box, 0, "a hidden rail must occupy no layout space");
  log("the projects rail also hides itself against a host that never sends `repos`");

  // ...and the brand keeps the left anchor the chip would otherwise have held.
  const layout = await page.evaluate(() => {
    const bar = document.querySelector(".top-bar").getBoundingClientRect();
    const brand = document.querySelector(".top-bar .afk-brand").getBoundingClientRect();
    // The LAST VISIBLE icon, not #new-btn specifically. This deliberately does
    // not care WHICH icons the header carries — New was in the overflow menu,
    // moved back to the top bar on 2026-08-17, and a legacy host may show a
    // different set again. Measuring a named button asserted nothing the day it
    // was hidden and its rect was 0. What matters is that whatever icons remain
    // still end at the right edge.
    const icons = [...document.querySelectorAll(".top-bar button, .top-bar #session-head-actions button")]
      .filter((el) => el.getBoundingClientRect().width > 0);
    const last = icons[icons.length - 1];
    return {
      barLeft: bar.left,
      barRight: bar.right,
      brandLeft: brand.left,
      newRight: last ? last.getBoundingClientRect().right : bar.right,
      iconCount: icons.length,
    };
  });
  assert.ok(layout.brandLeft - layout.barLeft < 12, `brand must stay left-anchored (was ${layout.brandLeft - layout.barLeft}px in)`);
  assert.ok(layout.iconCount > 0, "the top bar must still carry its icon cluster");
  assert.ok(layout.barRight - layout.newRight < 12, "the icon cluster must stay right-anchored");
  log("the top bar still lays out — brand left, icons right, no collapsed gap");

  // ---- 4. Remote upload becomes a bounded JPEG, never a host-local action. --
  await page.click("#add-btn");
  assert.equal(
    await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" }).count(),
    0,
    "a host that omitted capabilities must not get the document control",
  );
  assert.equal(
    await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add photo" }).count(),
    1,
    "the image affordance must remain available and identify itself as a photo path",
  );
  log("a legacy initialState exposes Add photo but no unsupported Add document control");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add photo" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "phone-source.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="5120" height="2560">' +
      '<rect width="100%" height="100%" fill="white"/><text x="80" y="180" font-size="96">remote screenshot</text></svg>',
    ),
  });
  for (let i = 0; i < 100 && !received.some((m) => m.type === "pasteImage"); i++) {
    await page.waitForTimeout(50);
  }
  const pasted = received.find((m) => m.type === "pasteImage");
  assert.ok(pasted, "the remote upload must reach the legacy host as pasteImage");
  assert.equal(pasted.mimeType, "image/jpeg", "the selected source type must be normalized to JPEG");
  assert.deepEqual(
    Buffer.from(pasted.data, "base64").subarray(0, 2),
    Buffer.from([0xff, 0xd8]),
    "payload must contain fresh JPEG bytes",
  );
  const normalizedSize = await page.evaluate((data) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = `data:image/jpeg;base64,${data}`;
  }), pasted.data);
  assert.deepEqual(normalizedSize, { width: 2560, height: 1280 }, "longest edge must be capped at 2560px");
  assert.equal(received.some((m) => m.type === "pickFile" || m.type === "dropFile"), false);
  assert.equal(received.some((m) => m.type === "uploadFile"), false);
  assert.equal(dropped.some((m) => m.type === "uploadFile"), false);
  log("the upload row emits a fresh 2560px JPEG via pasteImage, never pickFile/dropFile");

  // A selected file that cannot be decoded must fail visibly on the phone.
  await page.click("#add-btn");
  const badChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add photo" }).click();
  const badChooser = await badChooserPromise;
  await badChooser.setFiles({
    name: "broken.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("not an image"),
  });
  await page.locator(".msg.error", { hasText: "Could not attach image" }).waitFor({ timeout: 5000 });
  assert.match(
    await page.locator(".msg.error", { hasText: "Could not attach image" }).last().textContent(),
    /could not decode/i,
    "decode failure must explain itself in the chat",
  );
  log("an undecodable selection surfaces a visible phone-side error");

  // ---- 5. The ordinary work still works. -----------------------------------
  await page.fill("#input", "hello from an old host");
  await page.click("#send-btn");
  await page.waitForTimeout(400);
  const sent = received.find((m) => m.type === "send");
  assert.ok(sent, "a send must reach the legacy host");
  assert.equal(sent.text, "hello from an old host");
  log("sending a message round-trips to a v2.0.4 host");

  await page.click("#history-btn");
  await page.waitForTimeout(400);
  assert.ok(received.some((m) => m.type === "listSessions"), "history must ask the host for sessions");
  const rows = await page.evaluate(() => document.querySelectorAll(".history-row").length);
  assert.ok(rows >= 1, `the legacy host's sessions must render (got ${rows} rows)`);
  log("history opens and renders the legacy host's sessions");

  // Nothing the new client sent may have been refused by the old gate. This is
  // the check that catches a future non-additive change: if the client starts
  // emitting a type v2.0.4 can't route, it lands here rather than in the wild.
  assert.deepEqual(
    dropped.map((m) => m.type),
    [],
    `the client sent ${dropped.length} message(s) a v2.0.4 host would drop: ${JSON.stringify(dropped.map((m) => m.type))}`,
  );
  log("every message the client sent is one a v2.0.4 host accepts");

  // ---- 6. Contrast: a host that DOES speak `repos` gets the switcher. -------
  // Without this the checks above would also pass if the chip were simply dead.
  send({
    type: "repos",
    entries: [{ cwd: "/work/legacy", label: "legacy", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: "/work/legacy",
    activeCwd: "/work/legacy",
  });
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => {
    const el = document.getElementById("repo-btn");
    return { hidden: el.hidden, label: el.querySelector(".repo-chip-label")?.textContent };
  });
  assert.equal(shown.hidden, false, "a host that sends `repos` must get the chip");
  assert.equal(shown.label, "legacy", "and it must name the selected repo");
  log("a host that DOES advertise `repos` still gets the switcher — the gate is capability, not a kill switch");

  // The upload gate gets the same contrast case. Only an exact capability
  // proof may add the control, and a capable host receives canonical padded
  // FileReader base64 plus the original basename.
  uploadFileCapableHost = true;
  send({
    type: "initialState",
    version: "next",
    cwd: "/work/legacy",
    capabilities: { uploadFile: true, remoteVoice: true },
  });
  await page.click("#add-btn");
  const documentRow = page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" });
  await documentRow.waitFor({ state: "visible", timeout: 5000 });
  const documentChooserPromise = page.waitForEvent("filechooser");
  await documentRow.click();
  const documentChooser = await documentChooserPromise;
  const documentBytes = Buffer.from("phone document\n");
  await documentChooser.setFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: documentBytes,
  });
  for (let i = 0; i < 100 && !received.some((m) => m.type === "uploadFile"); i++) {
    await page.waitForTimeout(50);
  }
  const uploaded = received.find((m) => m.type === "uploadFile");
  assert.ok(uploaded, "a capability-bearing host must receive uploadFile");
  assert.equal(uploaded.name, "notes.md");
  assert.equal(uploaded.data, documentBytes.toString("base64"), "document data must be canonical padded base64");
  log("a host that proves uploadFile capability gets Add document and receives canonical base64");

  const uploadCount = received.filter((m) => m.type === "uploadFile").length;
  await page.click("#add-btn");
  const unsupportedChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" }).click();
  const unsupportedChooser = await unsupportedChooserPromise;
  await unsupportedChooser.setFiles({
    name: "archive.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not allowed"),
  });
  await page.locator(".msg.error", { hasText: "choose a .md" }).waitFor({ timeout: 5000 });
  assert.equal(received.filter((m) => m.type === "uploadFile").length, uploadCount);

  await page.click("#add-btn");
  const oversizedChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" }).click();
  const oversizedChooser = await oversizedChooserPromise;
  await oversizedChooser.setFiles({
    name: "too-large.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  await page.locator(".msg.error", { hasText: "exceeds the 20 MiB" }).waitFor({ timeout: 5000 });
  assert.equal(received.filter((m) => m.type === "uploadFile").length, uploadCount);

  await page.evaluate(() => {
    window.FileReader = class {
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
    };
  });
  await page.click("#add-btn");
  const unreadableChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#add-popover .toolbar-popover-item", { hasText: "Add document" }).click();
  const unreadableChooser = await unreadableChooserPromise;
  await unreadableChooser.setFiles({
    name: "unreadable.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cannot read this"),
  });
  await page.locator(".msg.error", { hasText: "selected file could not be read" }).waitFor({ timeout: 5000 });
  assert.equal(received.filter((m) => m.type === "uploadFile").length, uploadCount);
  log("unsupported, oversized, and unreadable documents fail visibly without emitting bytes");

  // A host outage on an otherwise-live browser socket gets a short grace
  // period. If it persists, the mic must stop through the real idle cleanup,
  // the transport gate must close, and repeated PCM bounces must stay silent.
  send({ type: "voiceState", status: "listening" });
  await page.locator("#mic-btn.listening").waitFor({ state: "visible", timeout: 5000 });
  const persistentVoiceError = page.locator(
    ".msg.error",
    { hasText: "Voice recording stopped because the device stayed offline" },
  );
  send({ type: "error", text: "Device offline" });
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator("#mic-btn.listening").count(),
    1,
    "a transient uplink race must not stop recording inside the grace window",
  );
  assert.equal(await persistentVoiceError.count(), 0, "the grace window must suppress the inline offline error");
  await page.locator("#mic-btn:not(.listening):not(.connecting):not(.transcribing)").waitFor({ timeout: 5000 });
  await persistentVoiceError.waitFor({ timeout: 5000 });
  send({ type: "error", text: "Device offline" });
  send({ type: "error", text: "Device offline" });
  await page.waitForTimeout(100);
  assert.equal(await persistentVoiceError.count(), 1, "persistent PCM bounces must produce one error, not a wall");
  const voiceChunksBeforeOfflineGate =
    received.filter((m) => m.type === "remoteVoiceChunk").length +
    dropped.filter((m) => m.type === "remoteVoiceChunk").length;
  await page.evaluate(() => acquireVsCodeApi().postMessage({
    type: "remoteVoiceChunk",
    data: "must-not-cross-persistent-offline-gate",
  }));
  await page.waitForTimeout(100);
  assert.equal(
    received.filter((m) => m.type === "remoteVoiceChunk").length +
      dropped.filter((m) => m.type === "remoteVoiceChunk").length,
    voiceChunksBeforeOfflineGate,
    "persistent host-offline state must close the voice transport gate",
  );
  log("persistent device-offline stops the mic after grace and deduplicates later PCM errors");

  // A subsequent host frame proves the uplink recovered. Re-arm the mic UI so
  // the browser-socket close path below still gets its own interruption check.
  send({ type: "setBusy", value: false });
  send({ type: "voiceState", status: "listening" });
  await page.locator("#mic-btn.listening").waitFor({ state: "visible", timeout: 5000 });

  // Byte-bearing attachments and live microphone frames are deliberately
  // excluded from the tab-discard outbox. Ordinary work is persisted, but the
  // actual reconnect open-handler must not flush it ahead of ready + identity
  // restoration on the fresh relay clientId.
  const reconnectEventStart = wireEvents.length;
  await page.evaluate(() => {
    const socket = [...window.__legacyTestSockets].reverse().find((candidate) => candidate.url.includes("/client?"));
    if (!socket) throw new Error("legacy test could not find the browser client WebSocket");
    socket.close();
  });
  await page.locator(".auth-overlay.reconnecting").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#mic-btn:not(.listening):not(.connecting):not(.transcribing)").waitFor({ timeout: 5000 });
  await page.locator(".msg.error", { hasText: "Voice recording stopped because the connection was interrupted" })
    .waitFor({ timeout: 5000 });
  await page.evaluate(() => acquireVsCodeApi().postMessage({
    type: "send",
    text: "queued-during-reconnect",
  }));
  await page.evaluate(() => {
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "send", text: "host-queued-once", queuedSendId: "queued-send-1" });
    vscode.postMessage({ type: "send", text: "host-queued-twice", queuedSendId: "queued-send-1" });
    vscode.postMessage({ type: "send", text: "repeat-me" });
    vscode.postMessage({ type: "send", text: "repeat-me" });
  });
  await page.evaluate(() => acquireVsCodeApi().postMessage({
    type: "pasteImage",
    mimeType: "image/png",
    data: "must-not-persist",
  }));
  await page.locator(".msg.error", { hasText: "Paste it again when it is online" }).waitFor({ timeout: 5000 });
  await page.evaluate(() => acquireVsCodeApi().postMessage({
    type: "uploadFile",
    name: "offline.md",
    data: "document-must-not-persist",
  }));
  await page.evaluate(() => {
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "remoteVoiceStart", marker: "voice-start-must-not-persist" });
    vscode.postMessage({ type: "remoteVoiceChunk", data: "voice-chunk-must-not-persist" });
    vscode.postMessage({ type: "remoteVoiceStop", marker: "voice-stop-must-not-persist" });
  });
  await page.locator(".msg.error", { hasText: "Could not attach document" }).last().waitFor({ timeout: 5000 });
  const persistedBeforeRestore = await page.evaluate(() => sessionStorage.getItem(
    "afk-outbox:" + new URLSearchParams(location.search).get("device"),
  ) || "");
  const persistedMessages = JSON.parse(persistedBeforeRestore).map((raw) => JSON.parse(raw));
  assert.equal(persistedBeforeRestore.includes("queued-during-reconnect"), true, "ordinary offline work must persist");
  assert.deepEqual(
    persistedMessages.filter((m) => m.queuedSendId === "queued-send-1"),
    [{ type: "send", text: "host-queued-once", queuedSendId: "queued-send-1" }],
    "outbox sends sharing a queuedSendId must collapse to the first entry",
  );
  assert.equal(
    persistedMessages.filter((m) => m.type === "send" && m.text === "repeat-me" && !("queuedSendId" in m)).length,
    2,
    "identical ordinary sends without queuedSendId must both remain in the outbox",
  );
  assert.equal(persistedBeforeRestore.includes("must-not-persist"), false, "pasteImage bytes must never enter sessionStorage");
  assert.equal(persistedBeforeRestore.includes("document-must-not-persist"), false, "uploadFile bytes must never enter sessionStorage");
  assert.equal(persistedBeforeRestore.includes("voice-start-must-not-persist"), false, "remoteVoiceStart must never persist");
  assert.equal(persistedBeforeRestore.includes("voice-chunk-must-not-persist"), false, "remoteVoiceChunk bytes must never persist");
  assert.equal(persistedBeforeRestore.includes("voice-stop-must-not-persist"), false, "remoteVoiceStop must never persist");

  await page.waitForFunction(() => window.__legacyTestSockets.length >= 2, null, { timeout: 5000 });
  for (let i = 0; i < 100 && !wireEvents.slice(reconnectEventStart).some((e) => e.type === "resumeSession"); i++) {
    await page.waitForTimeout(25);
  }
  assert.ok(
    wireEvents.slice(reconnectEventStart).some((e) => e.type === "resumeSession"),
    "the reconnected tab must re-assert its remembered session",
  );
  await page.fill("#input", "queued-after-open-before-confirm");
  await page.click("#send-btn");
  await page.waitForTimeout(250);
  assert.equal(
    wireEvents.slice(reconnectEventStart).some((e) => e.type === "send" && e.text === "queued-during-reconnect"),
    false,
    "the outbox must remain held while host identity confirmation is pending",
  );
  assert.equal(
    wireEvents.slice(reconnectEventStart).some((e) => e.type === "send" && e.text === "queued-after-open-before-confirm"),
    false,
    "user work posted after socket open must remain held while identity confirmation is pending",
  );
  // Wait for BOTH flushed sends, not just the first: they leave in one tick
  // but are recorded a tick apart, so polling on only the earlier one made
  // this check fail roughly one run in five.
  for (
    let i = 0;
    i < 100 && !["queued-during-reconnect", "queued-after-open-before-confirm"].every((text) =>
      wireEvents.slice(reconnectEventStart).some((e) => e.type === "send" && e.text === text));
    i++
  ) {
    await page.waitForTimeout(25);
  }
  const reconnectEvents = wireEvents.slice(reconnectEventStart);
  const readyAt = reconnectEvents.findIndex((e) => e.type === "client-ready");
  const selectAt = reconnectEvents.findIndex((e) => e.type === "selectRepo" && e.cwd === "/work/legacy");
  const resumeAt = reconnectEvents.findIndex((e) => e.type === "resumeSession" && e.id === "s1");
  const queuedSendAt = reconnectEvents.findIndex((e) => e.type === "send" && e.text === "queued-during-reconnect");
  const liveSendAt = reconnectEvents.findIndex((e) => e.type === "send" && e.text === "queued-after-open-before-confirm");
  assert.ok(readyAt >= 0, "the real open handler must send ready first");
  assert.ok(selectAt > readyAt, "the remembered repository must be re-asserted after ready");
  assert.ok(resumeAt > selectAt, "the remembered session must be re-asserted after its repository");
  assert.ok(queuedSendAt > resumeAt, "queued work must flush only after the restore commands and confirmations");
  assert.ok(liveSendAt > resumeAt, "live work must flush only after the restore commands and confirmations");
  assert.deepEqual(
    reconnectEvents.filter((e) => e.type === "resumeSession").map((e) => e.id),
    ["s1"],
    "restore must not auto-open the repo's newer s2 when its sessions frame follows selectRepo",
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem(
      "afk-outbox:" + new URLSearchParams(location.search).get("device"),
    )),
    "[]",
    "a confirmed restoration must clear the persisted outbox",
  );
  assert.equal(received.some((m) => m.type.startsWith("remoteVoice")), false, "offline voice frames must never reach the host");
  assert.equal(
    received.filter((m) => m.queuedSendId === "queued-send-1").length,
    1,
    "the deduplicated queued submission must flush exactly once",
  );
  assert.equal(
    received.filter((m) => m.type === "send" && m.text === "repeat-me" && !("queuedSendId" in m)).length,
    2,
    "both identical ordinary sends must flush",
  );
  log("reconnect restores identity, deduplicates queued submissions by id only, flushes ordinary repeats, and never persists live payloads");

  // A predecessor that errors or closes after the redial must not touch the
  // live socket: before connection identity, those listeners closed over
  // the module-level `ws` and would close the successor, which then
  // scheduled another connect().
  const staleGen = await page.evaluate(() => {
    const sockets = window.__legacyTestSockets.filter((s) => String(s.url).includes("/client?"));
    const stale = sockets[sockets.length - 2];
    const live = sockets[sockets.length - 1];
    if (!stale || !live) throw new Error("expected a predecessor and a live client socket");
    const before = { count: sockets.length, live: live.readyState };
    stale.dispatchEvent(new Event("error"));
    stale.dispatchEvent(new CloseEvent("close", { code: 4004, wasClean: false }));
    return {
      before,
      live: live.readyState,
      count: window.__legacyTestSockets.filter((s) => String(s.url).includes("/client?")).length,
      overlayReconnecting: !!document.querySelector(".auth-overlay.reconnecting"),
    };
  });
  assert.equal(staleGen.before.live, 1, "the successor must still be OPEN before the stale events");
  assert.equal(staleGen.live, 1, "a stale error/close must not close the live socket");
  assert.equal(staleGen.count, staleGen.before.count, "a stale close must not dial a third socket immediately");
  await page.waitForTimeout(1500);
  const afterStale = await page.evaluate(() => ({
    count: window.__legacyTestSockets.filter((s) => String(s.url).includes("/client?")).length,
    live: [...window.__legacyTestSockets].reverse().find((s) => String(s.url).includes("/client?"))?.readyState,
    overlayReconnecting: !!document.querySelector(".auth-overlay.reconnecting"),
  }));
  assert.equal(afterStale.count, staleGen.before.count, "a stale 4004 must not schedule another connect()");
  assert.equal(afterStale.live, 1, "the live socket must still be OPEN after the reconnect delay");
  assert.equal(afterStale.overlayReconnecting, false, "a stale close must not bounce a healthy session into reconnect");
  log("a stale socket error/close after a redial does not touch the live connection");

  // With no remembered identity, the host's default scope is already correct.
  // A fresh tab must therefore be able to send even if its snapshot legitimately
  // omits initialState; there is no restoration confirmation to wait for.
  const freshText = "fresh-tab-without-initial-state";
  const freshEventStart = wireEvents.length;
  omitInitialStateForNextClient = true;
  const freshPage = await ctx.newPage();
  await freshPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await freshPage.waitForFunction(
    () => typeof acquireVsCodeApi === "function",
    null,
    { timeout: 5000 },
  );
  for (let i = 0; i < 100 && !wireEvents.slice(freshEventStart).some((e) => e.type === "client-ready"); i++) {
    await freshPage.waitForTimeout(25);
  }
  assert.equal(
    wireEvents.slice(freshEventStart).some((e) => e.type === "client-ready"),
    true,
    "the coverage tab must connect before exercising its open-socket send path",
  );
  assert.equal(
    await freshPage.evaluate((deviceId) =>
      sessionStorage.getItem(`grok.remote.tabSession:${deviceId}`), deviceId),
    null,
    "the coverage tab must start without a remembered identity",
  );
  await freshPage.evaluate((text) => acquireVsCodeApi().postMessage({ type: "send", text }), freshText);
  for (let i = 0; i < 100 && !wireEvents.slice(freshEventStart).some((e) => e.type === "send" && e.text === freshText); i++) {
    await freshPage.waitForTimeout(25);
  }
  assert.equal(
    wireEvents.slice(freshEventStart).some((e) => e.type === "send" && e.text === freshText),
    true,
    "a tab with no remembered identity must send without waiting for initialState",
  );
  await freshPage.close();
  log("a fresh tab sends immediately when the host snapshot omits initialState");

  // A remembered session that has not appeared by the progress deadline stays
  // fail-closed, but its outbox remains preserved for a later confirmation.
  const missingText = "must-not-run-with-missing-session";
  const missingPage = await ctx.newPage();
  await missingPage.addInitScript(({ deviceId, missingText }) => {
    window.__grokIdentityRestoreTimeoutMs = 1000;
    sessionStorage.setItem(
      `grok.remote.tabSession:${deviceId}`,
      JSON.stringify({ id: "deleted-session", repoCwd: "/work/legacy", cwd: "/work/legacy" }),
    );
    sessionStorage.setItem(
      `afk-outbox:${deviceId}`,
      JSON.stringify([
        JSON.stringify({ type: "send", text: missingText, queuedSendId: "stale-queued-send" }),
        JSON.stringify({ type: "send", text: "duplicate-stale-work", queuedSendId: "stale-queued-send" }),
        JSON.stringify({ type: "send", text: "restored-repeat" }),
        JSON.stringify({ type: "send", text: "restored-repeat" }),
      ]),
    );
  }, { deviceId, missingText });
  await missingPage.addInitScript(() => {
    const track = { stop() {}, addEventListener() {} };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    class AudioNodeStub {
      connect() {}
      disconnect() {}
    }
    window.AudioContext = class {
      constructor() {
        this.audioWorklet = { addModule: async () => {} };
        this.destination = new AudioNodeStub();
      }
      createMediaStreamSource() { return new AudioNodeStub(); }
      createGain() {
        const node = new AudioNodeStub();
        node.gain = { value: 1 };
        return node;
      }
      close() { return Promise.resolve(); }
    };
    window.AudioWorkletNode = class extends AudioNodeStub {
      constructor() {
        super();
        this.port = {};
      }
    };
  });
  await missingPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await missingPage.locator(".msg.error", { hasText: "Still restoring the previous conversation" })
    .waitFor({ timeout: 5000 });
  assert.equal(
    received.some((m) => m.type === "send" && m.text === missingText),
    false,
    "queued work for a deleted session must never run",
  );
  assert.equal(
    await missingPage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    JSON.stringify([
      JSON.stringify({ type: "send", text: missingText, queuedSendId: "stale-queued-send" }),
      JSON.stringify({ type: "send", text: "restored-repeat" }),
      JSON.stringify({ type: "send", text: "restored-repeat" }),
    ]),
    "restoration must drop a stale duplicate id while preserving both identical ordinary sends",
  );
  const voiceStartsBeforeRecovery = received.filter((m) => m.type === "remoteVoiceStart").length;
  await missingPage.locator("#mic-btn").click();
  await missingPage.waitForTimeout(250);
  assert.equal(
    received.filter((m) => m.type === "remoteVoiceStart").length,
    voiceStartsBeforeRecovery,
    "an unconfirmed identity restoration must keep the mic transport gated",
  );
  await missingPage.locator(".msg.error", { hasText: "Voice recording is unavailable while the conversation reconnects" })
    .waitFor({ timeout: 5000 });
  await missingPage.close();
  log("an unconfirmed remembered session stays fail-closed while preserving queued work");

  console.log("[legacy] ALL CHECKS PASSED");
} finally {
  if (browser) await browser.close();
  if (uplink) try { uplink.close(); } catch { /* best effort */ }
  relay.kill();
}
