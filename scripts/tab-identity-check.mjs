// Browser regression for the cross-repo logical-tab contract. The vendored UI
// owns duplicate detection; chat.html must wait for its final-token promise
// before opening the relay handshake.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { chromium } from "playwright";

const PORT = Number(process.env.TAB_IDENTITY_CHECK_PORT || 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (message) => console.log(`[tab-identity] ${message}`);
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`relay never came up on ${BASE}`);
}

const postJson = async (path, body) =>
  (await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();

// 30s, not 10s. This already polls — the fragility was never a fixed sleep, it
// was the BUDGET. The slowest wait here spans a real Playwright page reload, a
// relay round trip and an outbox flush; on a loaded machine (or a shared CI
// runner, which is slower than a dev box) that overran 10s and reported
// "timed out waiting for original outbox flush after reload restore" on work
// that was perfectly correct. A generous ceiling cannot turn a passing run into
// a failing one — it only stops a slow one being called a failure — so the cost
// of raising it is bounded by how long a genuine break takes to surface.
async function waitFor(predicate, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

let browser;
let uplink;
try {
  await waitForRelay();
  const started = await postJson("/api/link/start", { name: "tab identity host" });
  await postJson("/api/link/approve", { code: started.code });
  const token = (await postJson("/api/link/poll", { code: started.code })).token;

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    uplink.once("open", resolve);
    uplink.once("error", reject);
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "tab identity host" } }));

  const devices = (await (await fetch(`${BASE}/api/devices`)).json()).devices;
  const deviceId = devices[0].deviceId;
  const originalToken = "original-logical-tab";
  const sessionId = "session-owned-by-original";
  const cwd = "/work/tab-identity";
  const readyEvents = [];
  const messages = [];
  const tokenByClient = new Map();

  const sendTo = (clientId, msgs) => uplink.send(JSON.stringify({
    t: "snapshot",
    clientId,
    msgs,
  }));
  const sendHostTo = (clientId, msg) => uplink.send(JSON.stringify({
    t: "host-to",
    clientIds: [clientId],
    msg,
  }));

  uplink.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.t === "client-ready") {
      tokenByClient.set(frame.clientId, frame.tabToken);
      const ownsSession = frame.tabToken === originalToken;
      readyEvents.push({ clientId: frame.clientId, tabToken: frame.tabToken, ownsSession });
      sendTo(frame.clientId, [
        { type: "clearMessages" },
        { type: "initialState", cwd, version: "tab-identity-test" },
        {
          type: "repos",
          entries: [{ cwd, label: "tab-identity", available: true, pinned: false, updatedAt: 1 }],
          selectedCwd: cwd,
          activeCwd: cwd,
        },
        {
          type: "sessions",
          entries: ownsSession
            ? [{ id: sessionId, displayName: "original conversation", updatedAt: 1, cwd }]
            : [],
          activeId: ownsSession ? sessionId : null,
          dots: {}, offset: 0, total: ownsSession ? 1 : 0,
          hasMore: false, nextOffset: ownsSession ? 1 : 0, query: "",
        },
        { type: "setBusy", value: false },
      ]);
      return;
    }
    if (frame.t !== "msg") return;
    messages.push({
      clientId: frame.clientId,
      tabToken: tokenByClient.get(frame.clientId),
      ...frame.msg,
    });
    if (frame.msg.type === "selectRepo") {
      sendHostTo(frame.clientId, {
        type: "repos",
        entries: [{ cwd, label: "tab-identity", available: true, pinned: false, updatedAt: 1 }],
        selectedCwd: cwd,
        activeCwd: cwd,
      });
    } else if (frame.msg.type === "resumeSession" && frame.msg.id === "refused-with-field") {
      sendHostTo(frame.clientId, {
        type: "error",
        text: "Could not restore this tab's previous conversation. It may have been deleted.",
        resumeFailed: { id: "refused-with-field" },
      });
      sendHostTo(frame.clientId, {
        type: "sessions",
        entries: [],
        // NULL activeId, as reality has it: a fresh tab's refusal is followed
        // by a list with no active conversation, so the old-host fallback
        // CANNOT fire here - only the resumeFailed field releases promptly.
        // (With a non-null different activeId this scenario exercised the
        // fallback and the primary path could be deleted without going red.)
        activeId: null,
        dots: {}, offset: 0, total: 0, hasMore: false, nextOffset: 0, query: "",
      });
    } else if (frame.msg.type === "resumeSession" && frame.msg.id === "refused-without-field") {
      // Prefix-only old-host refusal: no resumeFailed, and no sessions frame
      // with a different activeId. RED without the text-prefix path — the
      // dropped error+activeId heuristic cannot fire here.
      sendHostTo(frame.clientId, {
        type: "error",
        text: "Could not restore this tab's previous conversation. It may have been deleted.",
      });
    } else if (frame.msg.type === "resumeSession" && frame.msg.id === "offline-hold-session") {
      sendHostTo(frame.clientId, {
        type: "error",
        text: "Could not restore this tab's previous conversation. It may have been deleted.",
        resumeFailed: { id: "offline-hold-session" },
      });
    } else if (frame.msg.type === "resumeSession" && tokenByClient.get(frame.clientId) === originalToken) {
      sendHostTo(frame.clientId, {
        type: "sessions",
        entries: [{ id: sessionId, displayName: "original conversation", updatedAt: 1, cwd }],
        activeId: sessionId,
        dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
      });
    }
  });

  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);
  const context = await browser.newContext();

  const readVendoredTokenContract = async (page) => page.evaluate(async () => {
    const contract = window.__grokTabTokenReady;
    if (!contract || typeof contract.then !== "function") {
      return { provided: false, token: null };
    }
    return { provided: true, token: (await contract) || null };
  });

  const pageA = await context.newPage();
  await pageA.goto(BASE);
  await pageA.evaluate(({ deviceId, originalToken, sessionId, cwd }) => {
    sessionStorage.setItem(`grok.remote.tabToken:${deviceId}`, originalToken);
    sessionStorage.setItem(
      `grok.remote.tabSession:${deviceId}`,
      JSON.stringify({ id: sessionId, repoCwd: cwd, cwd }),
    );
  }, { deviceId, originalToken, sessionId, cwd });
  await pageA.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  const originalContract = await readVendoredTokenContract(pageA);
  assert.equal(
    originalContract.provided,
    true,
    "vendored chat.js must provide window.__grokTabTokenReady",
  );
  assert.equal(originalContract.token, originalToken, "vendored contract must settle to the original token");
  await waitFor(() => readyEvents.some((event) => event.tabToken === originalToken), "original tab ready");
  const originalClientId = readyEvents.find((event) => event.tabToken === originalToken).clientId;

  // Seed the queued work and open its duplicate in one browser task, so the
  // live page cannot rewrite the synthetic queue between setup and cloning.
  const popup = pageA.waitForEvent("popup");
  const originalStorage = await pageA.evaluate(({ deviceId, url }) => {
    sessionStorage.setItem(
      `afk-outbox:${deviceId}`,
      JSON.stringify([JSON.stringify({ type: "send", text: "copied-outbox-work" })]),
    );
    const storage = Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index);
      return [key, sessionStorage.getItem(key)];
    }));
    if (!window.open(url, "_blank")) throw new Error("duplicate popup was blocked");
    return storage;
  }, { deviceId, url: BASE });
  assert.ok(
    originalStorage[`grok.remote.tabOwner:${deviceId}`],
    "the live original must publish its owner marker before duplication",
  );

  // window.open is the browser operation whose new top-level context receives
  // a copy of the opener's complete sessionStorage. Keep both pages in this
  // BrowserContext so their same-origin BroadcastChannels can also see each
  // other, just as two real tabs in one profile do.
  const pageB = await popup;
  await pageB.waitForURL((url) => url.origin === BASE && url.pathname === "/");
  await pageB.waitForLoadState("load");
  assert.deepEqual(
    await pageB.evaluate(
      () => Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index);
        return [key, sessionStorage.getItem(key)];
      })),
    ),
    originalStorage,
    "a duplicate must begin with the original tab's complete sessionStorage",
  );

  const duplicateStart = readyEvents.length;
  await pageB.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  const duplicateContract = await readVendoredTokenContract(pageB);
  assert.equal(
    duplicateContract.provided,
    true,
    "vendored chat.js must provide the duplicate-claim token contract",
  );
  assert.notEqual(
    duplicateContract.token,
    originalToken,
    "vendored duplicate detection must settle to a fresh token",
  );
  await waitFor(
    () => readyEvents.slice(duplicateStart).some((event) => event.clientId !== originalClientId),
    "duplicate ready",
  );
  const duplicateReady = readyEvents.slice(duplicateStart)
    .find((event) => event.clientId !== originalClientId);
  assert.notEqual(duplicateReady.tabToken, originalToken, "duplicate must handshake only with its final fresh token");
  assert.notEqual(duplicateReady.clientId, originalClientId, "duplicate must be a separate relay client");
  assert.equal(duplicateReady.ownsSession, false, "duplicate must not inherit the original conversation");
  await pageB.waitForTimeout(250);
  assert.equal(
    messages.some((message) => message.clientId === duplicateReady.clientId && message.type === "resumeSession" && message.id === sessionId),
    false,
    "duplicate must not restore the original conversation",
  );
  assert.equal(
    messages.some((message) => message.clientId === duplicateReady.clientId && message.text === "copied-outbox-work"),
    false,
    "duplicate must not replay the original tab's copied outbox",
  );
  assert.equal(
    await pageB.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "duplicate must discard its copied persisted outbox",
  );
  log("a duplicated tab handshakes with a fresh token, stays independent, and drops its copied outbox");

  const reloadStart = readyEvents.length;
  // Re-seed the outbox in the SAME browser task that triggers the reload.
  //
  // The seed above is written into a key the LIVE page owns, and page A calls
  // saveQueue() on its own schedule — on connect, on identity restore, on any
  // send. Between the duplication assertions and this reload there is a window
  // where A writes its own empty queue over the synthetic one, and then there
  // is nothing left to flush. That made this check fail about half the time on
  // a loaded machine, in a way that read exactly like a product regression.
  //
  // The setup above already protects the seed→clone window for the same
  // reason ("so the live page cannot rewrite the synthetic queue"); this closes
  // the clone→reload window that was left open. `location.reload()` runs
  // synchronously after the write, so no page code can interleave. The evaluate
  // itself is expected to reject — its execution context is destroyed by the
  // navigation it just started.
  await Promise.all([
    pageA.waitForEvent("load"),
    pageA
      .evaluate((id) => {
        sessionStorage.setItem(
          `afk-outbox:${id}`,
          JSON.stringify([JSON.stringify({ type: "send", text: "copied-outbox-work" })]),
        );
        location.reload();
      }, deviceId)
      .catch(() => {}),
  ]);
  await waitFor(
    () => readyEvents.slice(reloadStart).some((event) => event.tabToken === originalToken),
    "reloaded original ready",
  );
  const reloadReady = readyEvents.slice(reloadStart).find((event) => event.tabToken === originalToken);
  assert.equal(reloadReady.ownsSession, true, "plain reload must inherit the original conversation");
  await waitFor(
    () => messages.some((message) => message.clientId === reloadReady.clientId && message.text === "copied-outbox-work"),
    "original outbox flush after reload restore",
  );
  assert.equal(
    await pageA.evaluate(() => document.body.classList.contains("identity-restoring")),
    false,
    "a completed restore must lift the transcript veil",
  );
  log("a plain reload keeps its token, restores its conversation, then flushes its own outbox");

  const openRestorePage = async (rememberedId, queuedText, extras = {}) => {
    const restorePage = await context.newPage();
    await restorePage.addInitScript(({ deviceId, rememberedId, cwd, queuedText, extras }) => {
      sessionStorage.setItem(
        `grok.remote.tabSession:${deviceId}`,
        JSON.stringify({ id: rememberedId, repoCwd: cwd, cwd }),
      );
      var queuedList = Array.isArray(queuedText) ? queuedText : [queuedText];
      sessionStorage.setItem(
        `afk-outbox:${deviceId}`,
        JSON.stringify(queuedList.map(function (text) { return JSON.stringify({ type: "send", text: text }); })),
      );
      if (extras.failMs) window.__grokIdentityRestoreFailMs = extras.failMs;
      if (extras.graceMs) window.__grokDeviceOfflineGraceMs = extras.graceMs;
    }, { deviceId, rememberedId, cwd, queuedText, extras });
    await restorePage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
    await restorePage.waitForFunction(
      () => typeof acquireVsCodeApi === "function",
      null,
      { timeout: 5000 },
    );
    return restorePage;
  };

  // RED without the machine-readable release path: the host's refusal is
  // human text, the identity target never confirms, and later activity keeps
  // announcing "Still restoring…".
  const fieldPage = await openRestorePage("refused-with-field", ["must-not-flush-after-field-refuse", "second-queued-send"]);
  await fieldPage.locator(".msg.error", { hasText: "the conversation could not be restored" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await fieldPage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "a resumeFailed refusal must drop the persisted outbox",
  );
  assert.equal(
    messages.some((message) => message.text === "must-not-flush-after-field-refuse"),
    false,
    "queued work must not flush after a resumeFailed refusal",
  );
  const fieldSendStart = messages.length;
  await fieldPage.evaluate(() => acquireVsCodeApi().postMessage({ type: "send", text: "after-field-refuse" }));
  await fieldPage.waitForTimeout(400);
  assert.equal(
    await fieldPage.locator(".msg.error", { hasText: "Still restoring the previous conversation" }).count(),
    0,
    "a released outbox must not keep announcing Still restoring",
  );
  assert.equal(
    messages.slice(fieldSendStart).some((message) => message.text === "after-field-refuse"),
    true,
    "work after a failed restore must send instead of remaining queued",
  );
  assert.equal(
    await fieldPage.locator("#input").inputValue(),
    "must-not-flush-after-field-refuse\n\nsecond-queued-send",
    "a queued send's text must return to the composer after abandonment",
  );
  await fieldPage.locator(".msg.error", { hasText: "returned to the input" })
    .waitFor({ timeout: 5000 });
  assert.equal(
    await fieldPage.evaluate(() => document.body.classList.contains("identity-restoring")),
    false,
    "a refused restore must lift the transcript veil",
  );
  await fieldPage.close();
  log("a resumeFailed refusal fails the outbox, returns the queued send to the composer, and does not keep announcing restore");

  // RED without the old-host TEXT-prefix path: the same human-text refusal
  // without resumeFailed and without a different-activeId sessions frame
  // leaves identityTarget set forever.
  const legacyRefusePage = await openRestorePage("refused-without-field", "must-not-flush-after-text-refuse");
  await legacyRefusePage.locator(".msg.error", { hasText: "the conversation could not be restored" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await legacyRefusePage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "an old-host Could not restore prefix must drop the outbox",
  );
  assert.equal(
    messages.some((message) => message.text === "must-not-flush-after-text-refuse"),
    false,
    "queued work must not flush after an old-host resume refusal",
  );
  const legacySendStart = messages.length;
  await legacyRefusePage.evaluate(() => acquireVsCodeApi().postMessage({ type: "send", text: "after-text-refuse" }));
  await legacyRefusePage.waitForTimeout(400);
  assert.equal(
    await legacyRefusePage.locator(".msg.error", { hasText: "Still restoring the previous conversation" }).count(),
    0,
    "the old-host prefix path must not leave Still restoring on later activity",
  );
  assert.equal(
    messages.slice(legacySendStart).some((message) => message.text === "after-text-refuse"),
    true,
    "work after an old-host refusal must send instead of remaining queued",
  );
  assert.equal(
    await legacyRefusePage.locator("#input").inputValue(),
    "must-not-flush-after-text-refuse",
    "an old-host refusal must also return the queued send to the composer",
  );
  await legacyRefusePage.close();
  log("an old-host refusal without resumeFailed still fails the outbox via the Could not restore prefix");

  // RED with the notice counting queue.length: a refusal over PURE BOOT
  // BOOKKEEPING (prefs sync, list requests — things a fresh page re-issues by
  // itself) must not tell the user "2 queued actions were not sent". The owner
  // refreshed an idle tab, queued nothing, and was told exactly that
  // (2026-08-15). The host's own refusal banner still shows; the queue still
  // empties — only the false mourning goes.
  const bookkeepingPage = await context.newPage();
  await bookkeepingPage.addInitScript(({ deviceId, cwd }) => {
    sessionStorage.setItem(
      `grok.remote.tabSession:${deviceId}`,
      JSON.stringify({ id: "refused-with-field", repoCwd: cwd, cwd }),
    );
    sessionStorage.setItem(
      `afk-outbox:${deviceId}`,
      JSON.stringify([
        // The REAL boot traffic (what actually queued on the owner's phone) —
        // not invented names: a made-up type would count as user work under
        // the drop-list polarity and this scenario would test nothing.
        JSON.stringify({ type: "remotePreferences", showThinking: true }),
        JSON.stringify({ type: "listSessions", offset: 0 }),
      ]),
    );
  }, { deviceId, cwd });
  await bookkeepingPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await bookkeepingPage.locator(".msg.error", { hasText: "Could not restore this tab's previous conversation" })
    .waitFor({ timeout: 10000 });
  await bookkeepingPage.waitForTimeout(400);
  assert.equal(
    await bookkeepingPage.locator(".msg.error", { hasText: "queued action" }).count(),
    0,
    "a bookkeeping-only outbox must fail silently — no 'queued actions' banner",
  );
  assert.equal(
    await bookkeepingPage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "the bookkeeping queue must still be dropped on refusal",
  );
  await bookkeepingPage.close();
  log("a bookkeeping-only outbox fails silently; the refusal banner stands alone");

  // RED without queueSend/steerSend recovery: text typed while a turn is
  // running queues as queueSend, not send — a refused restore must hand it
  // back to the composer all the same (it is the user's words, and this is
  // the last copy anywhere).
  const queuedTypePage = await context.newPage();
  await queuedTypePage.addInitScript(({ deviceId, cwd }) => {
    sessionStorage.setItem(
      `grok.remote.tabSession:${deviceId}`,
      JSON.stringify({ id: "refused-with-field", repoCwd: cwd, cwd }),
    );
    sessionStorage.setItem(
      `afk-outbox:${deviceId}`,
      JSON.stringify([JSON.stringify({ type: "queueSend", text: "typed-mid-turn" })]),
    );
  }, { deviceId, cwd });
  await queuedTypePage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await queuedTypePage.locator(".msg.error", { hasText: "returned to the input" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await queuedTypePage.locator("#input").inputValue(),
    "typed-mid-turn",
    "a queued queueSend's text must return to the composer on refusal",
  );
  await queuedTypePage.close();
  log("a refused restore hands queueSend text back to the composer");

  // Card-authored text must not depend on the outbox surviving restore.
  // An older tab may have persisted an exitPlanAnswer; recover the comment
  // and drop the frame rather than flushing it onto whatever session lands.
  const planCommentPage = await context.newPage();
  await planCommentPage.addInitScript(({ deviceId, cwd }) => {
    sessionStorage.setItem(
      `grok.remote.tabSession:${deviceId}`,
      JSON.stringify({ id: "refused-with-field", repoCwd: cwd, cwd }),
    );
    sessionStorage.setItem(
      `afk-outbox:${deviceId}`,
      JSON.stringify([JSON.stringify({
        type: "exitPlanAnswer",
        requestId: 1,
        verdict: "rejected",
        comment: "plan the auth part again",
      })]),
    );
  }, { deviceId, cwd });
  await planCommentPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await planCommentPage.locator(".msg.error", { hasText: "returned to the input" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await planCommentPage.locator("#input").inputValue(),
    "plan the auth part again",
    "a persisted plan comment must return to the composer instead of being replayed",
  );
  assert.equal(
    await planCommentPage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "a persisted plan answer must be dropped from the outbox, not flushed later",
  );
  const authoredAfter = await planCommentPage.evaluate(
    (deviceId) => sessionStorage.getItem(`afk-authored:${deviceId}`),
    deviceId,
  );
  assert.ok(
    authoredAfter === null || authoredAfter === "[]",
    "a returned plan comment must leave the durable authored store",
  );
  await planCommentPage.close();
  log("a persisted plan comment returns to the composer and leaves the outbox");

  // RED without chat.js forgetting empty conversations: the host reaps an
  // untouched session the moment a tab disconnects (#24), so REMEMBERING one
  // turns every refresh of a new tab into a refusal banner over a healthy
  // view. numMessages 0 + a blank view = forget; a host that then reports
  // real messages = remember again. (Entries with NO numMessages — this
  // harness's other scenarios — must keep being remembered: legacy hosts.)
  const emptyTabPage = await context.newPage();
  const emptyReadyStart = readyEvents.length;
  await emptyTabPage.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}`);
  await waitFor(() => readyEvents.length > emptyReadyStart, "empty-tab client ready");
  const emptyClientId = readyEvents[readyEvents.length - 1].clientId;
  const emptySessions = (numMessages) => ({
    type: "sessions",
    entries: [{ id: "brand-new-empty", displayName: "New session", updatedAt: 9, cwd, numMessages }],
    activeId: "brand-new-empty",
    dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
  });
  sendHostTo(emptyClientId, emptySessions(0));
  await emptyTabPage.waitForTimeout(400);
  assert.equal(
    await emptyTabPage.evaluate((deviceId) => sessionStorage.getItem(`grok.remote.tabSession:${deviceId}`), deviceId),
    null,
    "an active conversation the host reports EMPTY must not be remembered as tab identity",
  );
  sendHostTo(emptyClientId, emptySessions(1));
  await emptyTabPage.waitForTimeout(400);
  const rememberedAfterContent = await emptyTabPage.evaluate(
    (deviceId) => sessionStorage.getItem(`grok.remote.tabSession:${deviceId}`),
    deviceId,
  );
  assert.ok(
    rememberedAfterContent && JSON.parse(rememberedAfterContent).id === "brand-new-empty",
    `a conversation with real messages must be remembered again (got ${rememberedAfterContent})`,
  );
  await emptyTabPage.close();
  log("an empty conversation is never remembered; one with messages is");

  // RED without the restore veil: while identity is pending over an EMPTY
  // transcript with the device ONLINE (host connected but silent about the
  // resume), the intermediate "New session" paint must sit hidden behind the
  // restoring note instead of flashing and then being replaced.
  const heldPage = await openRestorePage("held-pending-session", "held-queued-text", { failMs: 30000 });
  await heldPage.waitForTimeout(900);
  assert.equal(
    await heldPage.evaluate(() =>
      document.body.classList.contains("identity-restoring") &&
      document.body.classList.contains("identity-restore-veil") &&
      getComputedStyle(document.getElementById("messages")).visibility === "hidden" &&
      // The top bar's session name is the same intermediate paint — "New
      // session" sat there for the restore window after the transcript was
      // already veiled (owner, 2026-08-15).
      getComputedStyle(document.getElementById("session-head-title")).visibility === "hidden" &&
      getComputedStyle(document.getElementById("identity-restoring-note")).display !== "none"),
    true,
    "a pending restore must veil the empty transcript AND the header title, and show the restoring note",
  );

  await waitFor(
    () => messages.some((message) => message.type === "resumeSession" && message.id === "held-pending-session"),
    "held restore resumeSession",
  );
  const heldClientId = messages.find(
    (message) => message.type === "resumeSession" && message.id === "held-pending-session",
  ).clientId;

  sendHostTo(heldClientId, { type: "error", text: "restore hiccup" });
  await heldPage.locator(".msg.error", { hasText: "restore hiccup" }).waitFor({ timeout: 5000 });
  assert.deepEqual(
    await heldPage.evaluate(() => ({
      messages: getComputedStyle(document.getElementById("messages")).visibility,
      error: getComputedStyle(document.querySelector(".msg.error")).visibility,
      note: getComputedStyle(document.getElementById("identity-restoring-note")).display,
      veil: document.body.classList.contains("identity-restore-veil"),
    })),
    { messages: "hidden", error: "visible", note: "flex", veil: true },
    "an error during restore is visible while the rest stays hidden",
  );

  sendHostTo(heldClientId, { type: "historyReplay", active: true });
  sendHostTo(heldClientId, { type: "userMessage", text: "replayed-a" });
  sendHostTo(heldClientId, { type: "userMessage", text: "replayed-b" });
  await heldPage.waitForFunction(
    () => document.querySelectorAll("#messages .msg.user").length >= 2,
    null,
    { timeout: 5000 },
  );
  assert.deepEqual(
    await heldPage.evaluate(() => ({
      messages: getComputedStyle(document.getElementById("messages")).visibility,
      note: getComputedStyle(document.getElementById("identity-restoring-note")).display,
      veil: document.body.classList.contains("identity-restore-veil"),
    })),
    { messages: "hidden", note: "flex", veil: true },
    "the transcript stays hidden while replay is still in flight",
  );

  sendHostTo(heldClientId, { type: "historyReplay", active: false });
  await heldPage.waitForTimeout(150);
  assert.equal(
    await heldPage.evaluate(() => document.body.classList.contains("identity-restore-veil")),
    true,
    "replay end alone must not reveal — identity restore is still in flight",
  );

  sendHostTo(heldClientId, {
    type: "sessions",
    entries: [{ id: "held-pending-session", displayName: "held conversation", updatedAt: 1, cwd }],
    activeId: "held-pending-session",
    dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
  });
  await heldPage.waitForFunction(
    () => !document.body.classList.contains("identity-restore-veil"),
    null,
    { timeout: 5000 },
  );
  assert.deepEqual(
    await heldPage.evaluate(() => ({
      messages: getComputedStyle(document.getElementById("messages")).visibility,
      veil: document.body.classList.contains("identity-restore-veil"),
      restoring: document.body.classList.contains("identity-restoring"),
    })),
    { messages: "visible", veil: false, restoring: false },
    "the transcript is revealed once after replay ends and restore completes",
  );
  await heldPage.close();
  log("a pending restore veils the empty transcript until identity resolves");

  // RED if the fail timer ignores device-offline: a low override would delete
  // the persisted queue during an ordinary outage with no refusal ever received.
  try { uplink.close(); } catch { /* reopen below */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const offlineQueued = "must-survive-offline-fail-timer";
  const offlinePage = await openRestorePage("offline-hold-session", offlineQueued, {
    failMs: 400,
    graceMs: 200,
  });
  await offlinePage.waitForTimeout(1600);
  // The veil must NOT own the screen while the device is offline — the
  // offline messaging does. (The client socket may not even open here; both
  // paths must leave the veil down.)
  assert.equal(
    await offlinePage.evaluate(() => document.body.classList.contains("identity-restoring")),
    false,
    "the restore veil must yield to offline messaging",
  );
  assert.equal(
    await offlinePage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    JSON.stringify([JSON.stringify({ type: "send", text: offlineQueued })]),
    "the fail timer must not drop the outbox while the device is offline",
  );
  assert.equal(
    await offlinePage.locator(".msg.error", { hasText: "the conversation could not be restored" }).count(),
    0,
    "an offline period must not abandon the restore",
  );

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  const pendingClientReady = [];
  let uplinkHelloSent = false;
  const handleUplinkFrame = (frame) => {
    if (frame.t === "client-ready") {
      if (!uplinkHelloSent) {
        pendingClientReady.push(frame);
        return;
      }
      tokenByClient.set(frame.clientId, frame.tabToken);
      readyEvents.push({ clientId: frame.clientId, tabToken: frame.tabToken, ownsSession: false });
      sendTo(frame.clientId, [
        { type: "clearMessages" },
        { type: "initialState", cwd, version: "tab-identity-test" },
        {
          type: "repos",
          entries: [{ cwd, label: "tab-identity", available: true, pinned: false, updatedAt: 1 }],
          selectedCwd: cwd,
          activeCwd: cwd,
        },
        {
          type: "sessions",
          entries: [],
          activeId: null,
          dots: {}, offset: 0, total: 0, hasMore: false, nextOffset: 0, query: "",
        },
        { type: "setBusy", value: false },
      ]);
      return;
    }
    if (frame.t !== "msg") return;
    messages.push({
      clientId: frame.clientId,
      tabToken: tokenByClient.get(frame.clientId),
      ...frame.msg,
    });
    if (frame.msg.type === "selectRepo") {
      sendHostTo(frame.clientId, {
        type: "repos",
        entries: [{ cwd, label: "tab-identity", available: true, pinned: false, updatedAt: 1 }],
        selectedCwd: cwd,
        activeCwd: cwd,
      });
    } else if (frame.msg.type === "resumeSession" && frame.msg.id === "offline-hold-session") {
      sendHostTo(frame.clientId, {
        type: "error",
        text: "Could not restore this tab's previous conversation. It may have been deleted.",
        resumeFailed: { id: "offline-hold-session" },
      });
    }
  };
  uplink.on("message", (raw) => handleUplinkFrame(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    uplink.once("open", resolve);
    uplink.once("error", reject);
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "tab identity host" } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  uplinkHelloSent = true;
  for (const frame of pendingClientReady) handleUplinkFrame(frame);
  await offlinePage.locator(".msg.error", { hasText: "the conversation could not be restored" })
    .waitFor({ timeout: 15000 });
  assert.equal(
    await offlinePage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "a refusal after the device returns must release the outbox",
  );
  assert.equal(
    await offlinePage.locator("#input").inputValue(),
    offlineQueued,
    "queued send text must return to the composer after the post-offline refusal",
  );
  await offlinePage.close();
  log("the fail timer holds through offline and only releases after a live refusal");

  // RED without the grace-clear re-arm: the device returns and emits ordinary
  // non-error frames (the client-ready snapshot), the host then never answers
  // the resume - the re-armed timer must release the outbox; without the
  // re-arm the queue is held forever with the socket open.
  try { uplink.close(); } catch { /* rebuilt below */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rearmQueued = "must-release-after-rearm";
  const rearmPage = await openRestorePage("rearm-hold-session", rearmQueued, {
    failMs: 500,
    graceMs: 200,
  });
  // Let the page enter offline grace first (timer cleared there).
  await rearmPage.waitForTimeout(600);
  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  const rearmPending = [];
  let rearmHelloSent = false;
  const handleRearmFrame = (frame) => {
    if (frame.t === "client-ready") {
      if (!rearmHelloSent) { rearmPending.push(frame); return; }
      // ONLY a repos frame - no initialState, so chat.js never re-asserts its
      // saved resume and the send-site arming cannot fire. Isolates the
      // grace-clear re-arm: without it, NOTHING arms the timer here.
      sendTo(frame.clientId, [
        {
          type: "repos",
          entries: [{ cwd, label: "tab-identity", available: true, pinned: false, updatedAt: 1 }],
          selectedCwd: cwd,
          activeCwd: cwd,
        },
      ]);
    }
    // resumeSession deliberately unanswered: the silent-host case.
  };
  uplink.on("message", (raw) => handleRearmFrame(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    uplink.once("open", resolve);
    uplink.once("error", reject);
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "tab identity host" } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  rearmHelloSent = true;
  for (const frame of rearmPending) handleRearmFrame(frame);
  await rearmPage.locator(".msg.error", { hasText: "the conversation could not be restored" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await rearmPage.evaluate((deviceId) => sessionStorage.getItem(`afk-outbox:${deviceId}`), deviceId),
    "[]",
    "the re-armed fail timer must release the outbox once the device is back and the host stays silent",
  );
  assert.equal(
    await rearmPage.locator("#input").inputValue(),
    rearmQueued,
    "the timed-out restore must hand the queued send back to the composer",
  );
  await rearmPage.close();
  log("a grace-clearing frame re-arms the fail timer, so a silent host cannot hold the outbox");
} finally {
  try { uplink?.close(); } catch {}
  try { await browser?.close(); } catch {}
  relay.kill();
}
