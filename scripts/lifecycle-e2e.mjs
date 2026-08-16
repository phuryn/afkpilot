#!/usr/bin/env node
// Cross-repo lifecycle e2e — real relay + real browser + real host + a restart.
//
// WHY THIS EXISTS. Every other harness here drives a real browser against a
// stub host that is instant, always warm, and never dies. The extension's
// integration tests drive a real host against a stubbed client. A bug that
// needs both real halves PLUS a restart is invisible by construction — that
// is how a restore race shipped through every gate. This is the first suite
// where all three of relay, browser and host are real, and the only one
// where the host dies in the middle.
//
// Part 1 (sibling grok-build-vscode, scripts/lifecycle-host.mjs) is a
// participant: it boots the unpackaged desktop app, prints READY after
// the uplink sees the relay `clients` frame (admission), and idles until
// told to stop. We still verify attachment from THIS side (GET /api/devices
// online:true, and an "uplink attached" log line) so a 4002-rejected
// READY cannot pass.
//
// Shutdown is the documented stdin line (GROK_LIFECYCLE_HOST_SHUTDOWN).
// Tree-kill (taskkill /T /F on Windows, process group on POSIX) is the
// backstop. POSIX process.kill(-pid) yields code === null plus a signal
// and does not set child.killed — wait for any of exit code, signal, or
// child.killed. We invoke the wrapper directly (not `npm run`) so the
// tree is node → electron. A green "restart" that never restarted is the
// failure class this suite exists to prevent.
//
// Journey: new session → send → second session in the same repo → refresh
// restore → host restart → reconnect → repo switch. Two alpha sessions
// exist so refresh/restart must restore the one this tab owned, not
// "whatever the host has live". Restart is before repo switch so a
// fixture that still mints a constant session id cannot hide a restart
// that never killed anything.
//
// The rail "+" on an unselected project is optimistic: it highlights a
// placeholder and posts selectRepo; the previous transcript stays painted
// until the host binds the new session. waitForChatUsable is already true
// on that previous conversation and is not a bind signal.
//
// Queued-while-down: a send after the host dies goes out on the still-open
// browser socket; the relay bounces Device offline; grace still swallows the
// banner (the usual reconnect race) but the client folds that send back into
// the persisted outbox and re-opens the identity gate so the replacement
// host's confirmation releases it. Arrival is the happy path. A replacing
// start that already echoed the user bubble cannot be replayed (duplicate),
// so that interleaving ends as interrupted-after-echo — named, not treated
// as arrival. Isolation still runs so one red does not hide the other.
//
// Locally, skip loudly (print why, exit 0) when the sibling checkout is
// absent. CI sets LIFECYCLE_REQUIRE_HOST=1 so the same absence fails.
// Never skip silently. Precedent: grok-build-vscode f5006be.
//
// Run: npm run e2e:lifecycle
// Env:  LIFECYCLE_PORT (default 8795)
//       GROK_BUILD_VSCODE (override sibling path)
//       LIFECYCLE_REQUIRE_HOST=1  — fail instead of skip when the host is missing
//       LIFECYCLE_INVERT=comma-list  — deliberate faults for invert-verify
//         skip-kill          do not kill the host before "restart"
//         skip-offline-wait  kill but do not wait for the relay to drop it
//         skip-admission     treat READY as "host is usable"
//         forget-identity    wipe tab session memory before refresh
//         skip-queue-send    do not queue work while the host is down
//         skip-repo-switch   stay on the first repo, still assert isolation
//         expect-first-session  after refresh, assert the FIRST alpha
//                               conversation (must go red — we were on the second)
//
// Invert-verify (observed):
//   forget-identity — NOW goes red once two alpha sessions exist: reload
//     without tab memory lands on the first conversation (lifecycle-alpha-one)
//     instead of the second. Last round this invert stayed green because a
//     single live session and the host snapshot were the same picture.
//   expect-first-session — "timed out waiting for INVERT expect-first-session
//     still asserts the first conversation".
//   skip-queue-send — "timed out waiting for INVERT skip-queue-send still
//     asserts the unsent prompt arrived".
//   skip-repo-switch — "INVERT: isolation asserted without switching".
//   skip-kill — READY prints on the duplicate, then "timed out waiting for
//     relay to admit the replacement host (not a 4002-rejected READY, not
//     the old zombie)".
//
// Queue-release invert (unit, not LIFECYCLE_INVERT): interrupted-after-echo
// is not exercised by arrived e2e runs. The harness unit suite stays red
// on an unrelated post-echo error and on a stale interrupted-send code.

import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RELAY_ROOT = resolve(HERE, "..");
export const LIFECYCLE_HOST_SCRIPT = join("scripts", "lifecycle-host.mjs");
export const LIFECYCLE_HOST_READY_LINE = "GROK_LIFECYCLE_HOST_READY";
export const LIFECYCLE_HOST_SHUTDOWN_LINE = "GROK_LIFECYCLE_HOST_SHUTDOWN";
export const REPLACEMENT_HOST_FRAME_TYPES = Object.freeze([
  "initialState",
  "clearMessages",
  "sessions",
  "session",
  "repos",
]);
const HOST_STDIN_SHUTDOWN_WAIT_MS = 12_000;

const PORT = Number(process.env.LIFECYCLE_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const log = (m) => console.log(`[lifecycle] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const PROMPT_A = "lifecycle-alpha-one";
const PROMPT_A2 = "lifecycle-alpha-two";
const PROMPT_B = "lifecycle-bravo-two";
const PROMPT_QUEUED = "lifecycle-queued-while-down";
const AGENT_OK = "ok";

export function parseInvert(raw = process.env.LIFECYCLE_INVERT) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function hostRequired(env = process.env) {
  const v = String(env.LIFECYCLE_REQUIRE_HOST || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function hostProcessGone(handle) {
  if (!handle) return true;
  if (handle.exitCode != null) return true;
  if (handle.signal != null) return true;
  if (handle.child && handle.child.killed) return true;
  return false;
}

export function isReplacementHostFrameType(type) {
  return REPLACEMENT_HOST_FRAME_TYPES.includes(type);
}

export function queuedTurnArrived(transcript, prompt, agentsBefore) {
  const user = Array.isArray(transcript?.users) && transcript.users.some((u) => String(u).includes(prompt));
  const agents = Array.isArray(transcript?.agents) ? transcript.agents : [];
  const before = Number.isFinite(agentsBefore) && agentsBefore > 0 ? agentsBefore : 0;
  if (agents.length <= before) return false;
  // Only the bubbles added after the snapshot. An earlier turn's "ok" must
  // not satisfy a later send.
  const added = agents.slice(before);
  return !!(user && added.some((a) => String(a).includes(AGENT_OK)));
}

// Additive host marker for the post-echo restart bail. New hosts stamp
// `code: "interrupted-send"` on that error. Older hosts emit the sentence
// and no code — the phrase is the compatibility path, never enough on its
// own, and never enough on an unrelated error.
export const INTERRUPTED_SEND_CODE = "interrupted-send";
export const INTERRUPTED_SEND_PHRASE = /was being sent, so delivery is uncertain/;

export function isInterruptedSendPhrase(text) {
  return INTERRUPTED_SEND_PHRASE.test(String(text || ""));
}

export function errorMarksInterruptedSend(frame) {
  if (!frame || frame.type !== "error") return false;
  if (frame.code === INTERRUPTED_SEND_CODE) return true;
  if (frame.code) return false;
  return isInterruptedSendPhrase(frame.text);
}

function frameEchoesPrompt(frame, prompt) {
  return !!(
    frame &&
    frame.type === "userMessage" &&
    String(prompt || "") &&
    String(frame.text || "").includes(prompt)
  );
}

function errorMatchesEcho(error, echo) {
  if (!error || !echo) return false;
  if (typeof error.submissionId === "string" && error.submissionId) {
    return echo.submissionId === error.submissionId;
  }
  return true;
}

function isDifferentSubmission(frame, echo, prompt) {
  if (!frame || frame.type !== "userMessage") return false;
  if (!frameEchoesPrompt(frame, prompt)) return true;
  const echoId = typeof echo.submissionId === "string" && echo.submissionId;
  const frameId = typeof frame.submissionId === "string" && frame.submissionId;
  if (echoId && frameId && echoId !== frameId) return true;
  return false;
}

// The named interrupt (or the old-host phrase) on the error that follows
// THIS prompt's userMessage. A stale interrupted-send anywhere, or any
// error after any userMessage, is not evidence. Restart can replay the
// same buffered userMessage after a valid pair — accept any matching
// echo followed by its interrupt before the next different submission.
export function queuedSendInterruptedAfterEcho(frames, prompt) {
  const list = Array.isArray(frames) ? frames : [];
  for (let i = 0; i < list.length; i++) {
    if (!frameEchoesPrompt(list[i], prompt)) continue;
    const echo = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const frame = list[j];
      if (!frame) continue;
      if (isDifferentSubmission(frame, echo, prompt)) break;
      if (frame.type !== "error") continue;
      if (errorMatchesEcho(frame, echo) && errorMarksInterruptedSend(frame)) return true;
    }
  }
  return false;
}

export function classifyQueueRelease(transcript, prompt, agentsBefore = 0, frames = []) {
  if (queuedTurnArrived(transcript, prompt, agentsBefore)) return "arrived";
  const users = Array.isArray(transcript?.users) ? transcript.users : [];
  const echoed = users.some((u) => String(u).includes(prompt));
  if (echoed && queuedSendInterruptedAfterEcho(frames, prompt)) return "interrupted-after-echo";
  const input = String(transcript?.input || "");
  const queued = Array.isArray(transcript?.queued) ? transcript.queued : [];
  if (input.includes(prompt) || queued.some((u) => String(u).includes(prompt))) {
    return "failed-visibly-recoverable";
  }
  return null;
}

export function isFollowUpNewSessionFrame(type) {
  return type === "clearMessages" || type === "setBusy" || type === "session";
}

export function unselectedRepoPlusSettled({
  previousPrompts = [],
  users = [],
  restoring = false,
  welcome = "",
  sendTitle = "",
  railNewIntent = null,
  sessionFramesSinceClick = 0,
} = {}) {
  if (restoring) return false;
  if (railNewIntent) return false;
  if (/Loading conversation/i.test(welcome || "")) return false;
  if (/Initializing|Starting/i.test(sendTitle || "")) return false;
  if (previousPrompts.some((p) => users.some((u) => String(u).includes(p)))) return false;
  // Unselected-repo "+" is selectRepo (host mints when the repo is empty) plus
  // a follow-up newSession. One `session` frame is the first mint; the
  // composer is usable then. Empty new sessions are not written to tab
  // identity, so a remembered-id check deadlocks.
  return sessionFramesSinceClick >= 2;
}

export function describeIsolationMismatch({
  expectedRepo,
  remembered,
  previousId,
  users,
  title,
} = {}) {
  const id = remembered && remembered.id;
  const parts = [
    `after switching to ${expectedRepo} the tab still shows the previous conversation`,
    `remembered id=${JSON.stringify(id ?? null)}`,
    `previous id=${JSON.stringify(previousId ?? null)}`,
    `header=${JSON.stringify(title ?? "")}`,
    `users=${JSON.stringify(users ?? [])}`,
  ];
  if (id === "fake-session-1") {
    parts.push(
      "observed id is the constant fake-session-1 (fixture still minting one id)",
    );
  }
  return parts.join(". ");
}

export function resolveExtensionRoot(env = process.env, relayRoot = RELAY_ROOT) {
  const override = typeof env.GROK_BUILD_VSCODE === "string" ? env.GROK_BUILD_VSCODE.trim() : "";
  if (override) return resolve(override);
  return resolve(relayRoot, "..", "grok-build-vscode");
}

export function skipReason(extensionRoot) {
  if (!extensionRoot || !existsSync(extensionRoot)) {
    return (
      `sibling grok-build-vscode checkout not found at ${extensionRoot}. ` +
      `This suite needs the real host from that repo (${LIFECYCLE_HOST_SCRIPT}). ` +
      `Clone it next to this repo, or set GROK_BUILD_VSCODE.`
    );
  }
  const host = join(extensionRoot, LIFECYCLE_HOST_SCRIPT);
  if (!existsSync(host)) {
    return (
      `lifecycle host runner missing at ${host} ` +
      `(need part 1, commit 831ff3b). The checkout exists but is too old.`
    );
  }
  return null;
}

export function sessionStoreDir(grokHome, cwd, sessionId) {
  return join(grokHome, "sessions", encodeURIComponent(resolve(cwd)), sessionId);
}

export function persistTurnForLoad(grokHome, cwd, sessionId, userText, agentText) {
  // The fake ACP CLI's session/load already knows how to replay these files.
  // It does not persist a live turn itself. GROK_HOME is ours; seeding the
  // replay log is composing with that documented load path so a restart can
  // restore the conversation the tab already showed — not a protocol change.
  const dir = sessionStoreDir(grokHome, cwd, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: userText } },
    }),
    JSON.stringify({
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: agentText } },
    }),
  ];
  writeFileSync(join(dir, "updates.jsonl"), `${lines.join("\n")}\n`);
  const summary = join(dir, "summary.json");
  if (!existsSync(summary)) {
    writeFileSync(summary, JSON.stringify({ session_id: sessionId, num_messages: 2 }));
  }
}

export async function waitFor(predicate, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const extra = lastErr ? ` (last error: ${(lastErr && lastErr.message) || lastErr})` : "";
  throw new Error(`timed out waiting for ${description}${extra}`);
}

export function launchedDirectly() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1] && resolve(process.argv[1]);
  return argv1 === self;
}

function invertSet() {
  return parseInvert();
}

function inverted(name) {
  return invertSet().has(name);
}

const postJson = async (p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${p} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
};

async function listDevices() {
  const res = await fetch(`${BASE}/api/devices`);
  if (!res.ok) throw new Error(`GET /api/devices → ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.devices) ? body.devices : [];
}

async function deviceRow(deviceId) {
  return (await listDevices()).find((d) => d.deviceId === deviceId) || null;
}

function ensureSiblingBuilt(extensionRoot) {
  const frames = join(extensionRoot, "out", "remote-frames.js");
  const desktop = join(extensionRoot, "out", "desktop", "main.js");
  const electron = join(
    extensionRoot,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  if (!existsSync(electron)) {
    throw new Error(
      `Electron missing at ${electron}. Run \`npm install\` in ${extensionRoot}.`,
    );
  }
  // Always compile. An existing out/ from an earlier tree is not the tree
  // under test — skipping here is how a source change goes green against
  // yesterday's host.
  log("compiling sibling grok-build-vscode (always — do not trust a stale out/)");
  const compiled = spawnSync("npm", ["run", "compile"], {
    cwd: extensionRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (compiled.status !== 0) {
    throw new Error(`sibling compile failed (exit ${compiled.status})`);
  }
  if (!existsSync(frames) || !existsSync(desktop)) {
    throw new Error(`sibling compile finished but still missing ${frames} or ${desktop}`);
  }
}

function spawnRelay() {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      RELAY_PORT: String(PORT),
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = {
    child,
    stdout: "",
    stderr: "",
    listening: false,
    attachCount: 0,
    detachCount: 0,
  };
  const scan = (buf, which) => {
    const text = buf.toString("utf8");
    state[which] += text;
    if (text.includes(`listening on http://127.0.0.1:${PORT}`)) state.listening = true;
    const attached = text.match(/\[relay\] uplink attached/g);
    if (attached) state.attachCount += attached.length;
    const detached = text.match(/\[relay\] uplink detached/g);
    if (detached) state.detachCount += detached.length;
    if (/burst cap/i.test(text) || /free tier/i.test(text) || /MOCK SESSION AUTH/i.test(text)) {
      process.stdout.write(text);
    }
  };
  child.stdout.on("data", (b) => scan(b, "stdout"));
  child.stderr.on("data", (b) => scan(b, "stderr"));
  return state;
}

async function waitForRelayListening(relay, timeoutMs = 20000) {
  await waitFor(() => {
    if (relay.child.exitCode != null) {
      throw new Error(
        `relay exited (code ${relay.child.exitCode}) before listening on ${PORT}. ` +
          `Port taken?\n${relay.stderr.slice(0, 800)}`,
      );
    }
    return relay.listening;
  }, `relay stdout line "listening on http://127.0.0.1:${PORT}"`, timeoutMs);
}

async function mintDeviceToken() {
  const started = await postJson("/api/link/start", { name: "lifecycle host" });
  assert.ok(started.code, `link/start must return {code}, got ${JSON.stringify(started)}`);
  assert.equal(String(started.code).length, 8, "link/start returns an 8-character pairing code, not a token");
  assert.equal(started.token, undefined, "link/start must not return a token");
  const approved = await postJson("/api/link/approve", { code: started.code });
  assert.equal(approved.ok, true, `link/approve failed: ${JSON.stringify(approved)}`);
  const polled = await postJson("/api/link/poll", { code: started.code });
  assert.ok(polled.token, `link/poll must return {token}, got ${JSON.stringify(polled)}`);
  return { token: polled.token, deviceId: approved.deviceId };
}

function spawnHost(extensionRoot, env) {
  const script = join(extensionRoot, LIFECYCLE_HOST_SCRIPT);
  const posix = process.platform !== "win32";
  const child = spawn(process.execPath, [script], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      ...env,
      ELECTRON_RUN_AS_NODE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: posix,
  });
  const handle = {
    child,
    pid: child.pid,
    stdout: "",
    stderr: "",
    ready: false,
  };
  const scan = (buf, which) => {
    const text = buf.toString("utf8");
    handle[which] += text;
    if (text.includes(LIFECYCLE_HOST_READY_LINE)) handle.ready = true;
  };
  child.stdout.on("data", (b) => scan(b, "stdout"));
  child.stderr.on("data", (b) => scan(b, "stderr"));
  child.on("exit", (code, signal) => {
    handle.exitCode = code;
    handle.signal = signal;
  });
  return handle;
}

async function waitForHostReadyLine(handle, timeoutMs = 90000) {
  await waitFor(() => {
    if (handle.exitCode != null && !handle.ready) {
      throw new Error(
        `host exited before READY (code ${handle.exitCode}, signal ${handle.signal})\n` +
          handle.stderr.slice(-1500),
      );
    }
    return handle.ready;
  }, `host stdout line ${LIFECYCLE_HOST_READY_LINE} (child got that far — not admission)`, timeoutMs);
}

async function waitForAdmission(relay, deviceId, attachAtLeast, description, timeoutMs = 30000) {
  if (inverted("skip-admission")) {
    log(`INVERT skip-admission — treating READY as usable (${description})`);
    return;
  }
  await waitFor(async () => {
    const row = await deviceRow(deviceId);
    return !!(row && row.online === true) && relay.attachCount >= attachAtLeast;
  }, description, timeoutMs);
}

async function requestHostShutdown(handle) {
  if (hostProcessGone(handle)) return;
  const stdin = handle.child && handle.child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return;
  try {
    stdin.write(`${LIFECYCLE_HOST_SHUTDOWN_LINE}\n`);
  } catch {
    /* already closed */
  }
}

async function treeKillHost(handle) {
  if (hostProcessGone(handle)) return;
  const pid = handle.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function killHostTree(handle) {
  if (hostProcessGone(handle)) return;
  await requestHostShutdown(handle);
  const deadline = Date.now() + HOST_STDIN_SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (hostProcessGone(handle)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  await treeKillHost(handle);
}

async function waitForHostDead(relay, handle, deviceId, timeoutMs = 30000) {
  await waitFor(
    () => hostProcessGone(handle),
    `host process tree (pid ${handle.pid}) to exit after shutdown (code, signal, or killed)`,
    timeoutMs,
  );
  if (inverted("skip-offline-wait")) {
    log("INVERT skip-offline-wait — not waiting for the relay to drop the uplink");
    return;
  }
  const detachAtLeast = relay.detachCount + 1;
  await waitFor(async () => {
    const row = await deviceRow(deviceId);
    const offline = !row || row.online === false;
    return offline && relay.detachCount >= detachAtLeast - 1 && !row?.online;
  }, "relay to drop the old uplink (GET /api/devices online:false) before any restart", timeoutMs);
}

function makeWorkspace(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nlifecycle workspace\n`);
  return dir;
}

async function readTranscript(page) {
  return page.evaluate(() => {
    const texts = (sel) => [...document.querySelectorAll(sel)].map((el) => (el.innerText || "").trim());
    const errorNodes = [...document.querySelectorAll(".msg.error")];
    return {
      users: texts(".msg.user:not(.queued)"),
      agents: texts(".msg.agent"),
      errors: errorNodes.map((el) => (el.innerText || "").trim()),
      errorCodes: errorNodes.map((el) => el.getAttribute("data-error-code")).filter(Boolean),
      queued: texts(".msg.user.queued"),
      notSent: [...document.querySelectorAll(".queued-tag")].map((el) => (el.textContent || "").trim()),
      input: document.querySelector("#input")?.value || "",
      restoring: document.body.classList.contains("identity-restoring"),
      sendTitle: document.querySelector("#send-btn")?.getAttribute("title") || "",
      welcome: document.querySelector("#welcome-version")?.textContent || "",
    };
  });
}

async function readRememberedSession(page, deviceId) {
  return page.evaluate((id) => {
    try {
      const raw = sessionStorage.getItem(`grok.remote.tabSession:${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, deviceId);
}

function looksLikeBurstCap(text) {
  return /Slow down|at most \d+ messages per minute|Free plan limit reached/i.test(String(text || ""));
}

function assertNotBurst(transcript, where) {
  const hit = [...transcript.errors, transcript.welcome].find(looksLikeBurstCap);
  if (hit) {
    throw new Error(
      `${where}: hit the relay burst/free-tier cap (${hit}). ` +
        `This suite must stay well under 20 messages/minute; do not raise the limits.`,
    );
  }
}

async function waitForChatUsable(page, description = "chat composer to become usable") {
  await page.waitForSelector("#input", { timeout: 30000 });
  await waitFor(async () => {
    const t = await readTranscript(page);
    if (t.restoring) return false;
    if (/Connecting|Starting|Loading conversation/i.test(t.welcome)) return false;
    const send = page.locator("#send-btn");
    const title = (await send.getAttribute("title").catch(() => "")) || "";
    if (/Initializing|Starting/i.test(title)) return false;
    return true;
  }, description, 45000);
}

async function clickNewSession(page) {
  const sessionNew = page.locator("#session-new");
  if (await sessionNew.isVisible().catch(() => false)) {
    await sessionNew.click();
    return;
  }
  const overflow = page.locator("#session-head-actions .rail-menu-btn");
  await overflow.waitFor({ state: "visible", timeout: 20000 });
  await overflow.click();
  const item = page.locator(".rail-menu-item", { hasText: "New session" });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
}

async function sendPrompt(page, text) {
  const input = page.locator("#input");
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  await page.locator("#send-btn").click();
}

async function waitForAnsweredTurn(page, prompt, where, agentsBefore = 0) {
  await waitFor(async () => {
    const t = await readTranscript(page);
    assertNotBurst(t, where);
    return queuedTurnArrived(t, prompt, agentsBefore);
  }, `${where}: user prompt ${JSON.stringify(prompt)} and a new agent ${JSON.stringify(AGENT_OK)}`, 45000);
}

async function hostFramesSince(page, since) {
  return page.evaluate((n) => (window.__lifecycleHostFrames || []).slice(n), since);
}

async function waitForVisibleFailureOrArrival(page, prompt, where, agentsBefore = 0, framesSince = 0) {
  let outcome = "";
  await waitFor(async () => {
    const t = await readTranscript(page);
    assertNotBurst(t, where);
    const frames = await hostFramesSince(page, framesSince);
    const classified = classifyQueueRelease(t, prompt, agentsBefore, frames);
    if (classified) {
      outcome = classified;
      return true;
    }
    return false;
  }, `${where}: queued work ${JSON.stringify(prompt)} to arrive, interrupt after echo, or fail with the text recoverable (silent drop is the defect)`, 45000);
  return outcome;
}

async function startNewSessionInRepo(page, label) {
  const repo = page.locator(".rail-repo").filter({
    has: page.locator(".rail-repo-label", { hasText: label }),
  });
  await repo.waitFor({ state: "visible", timeout: 20000 });
  // The + lives inside `.rail-repo-head`, which is itself a click target
  // (fold). Playwright's hit-test lands on the head; a real pointer click
  // on the button still works because the action cluster stopPropagation.
  const add = repo.locator("button[title*='New session'], button[title*='start a new session']").first();
  await add.waitFor({ state: "visible", timeout: 10000 });
  await add.evaluate((el) => el.click());
}

async function waitForRailPlusSettled(page, {
  previousPrompts,
  framesBeforeClick,
  where,
}) {
  await waitFor(async () => {
    const t = await readTranscript(page);
    assertNotBurst(t, where);
    const intent = await page.evaluate(() => window.__grokRailNewIntent || null);
    const frames = await hostFramesSince(page, framesBeforeClick);
    const sessionFrames = frames.filter((f) => f && f.type === "session").length;
    return unselectedRepoPlusSettled({
      previousPrompts,
      users: t.users,
      restoring: t.restoring,
      welcome: t.welcome,
      sendTitle: t.sendTitle,
      railNewIntent: intent,
      sessionFramesSinceClick: sessionFrames,
    });
  }, where, 45000);
}

async function resumeRepoSession(page, label, sessionText) {
  const repo = page.locator(".rail-repo").filter({
    has: page.locator(".rail-repo-label", { hasText: label }),
  });
  await repo.waitFor({ state: "visible", timeout: 20000 });
  const session = sessionText
    ? repo.locator(".rail-session").filter({ hasText: sessionText }).first()
    : repo.locator(".rail-session").first();
  if (await session.isVisible().catch(() => false)) {
    await session.evaluate((el) => el.click());
    return;
  }
  const head = repo.locator(".rail-repo-head");
  await head.evaluate((el) => el.click());
}

async function readClientDump(page) {
  return page.evaluate(() => {
    const texts = (sel) => [...document.querySelectorAll(sel)].map((el) => (el.innerText || "").trim());
    const errorNodes = [...document.querySelectorAll(".msg.error")];
    const deviceId = new URLSearchParams(location.search).get("device") || "";
    let outbox = null;
    let remembered = null;
    try { outbox = sessionStorage.getItem("afk-outbox:" + deviceId); } catch (_) { /* */ }
    try {
      const raw = sessionStorage.getItem(`grok.remote.tabSession:${deviceId}`);
      remembered = raw ? JSON.parse(raw) : null;
    } catch (_) { /* */ }
    return {
      users: texts(".msg.user:not(.queued)"),
      agents: texts(".msg.agent"),
      queued: texts(".msg.user.queued"),
      errors: errorNodes.map((el) => (el.innerText || "").trim()),
      errorCodes: errorNodes.map((el) => el.getAttribute("data-error-code")).filter(Boolean),
      input: document.querySelector("#input")?.value || "",
      restoring: document.body.classList.contains("identity-restoring"),
      sendTitle: document.querySelector("#send-btn")?.getAttribute("title") || "",
      welcome: document.querySelector("#welcome-version")?.textContent || "",
      railNewIntent: window.__grokRailNewIntent || null,
      remembered,
      outbox,
      hostFrames: window.__lifecycleHostFrames || [],
    };
  });
}

function writeLifecycleArtifact(name, value) {
  const dir = join(RELAY_ROOT, "e2e-artifacts", "lifecycle");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function dumpFailure(page, relay, host, label) {
  try {
    const dir = join(RELAY_ROOT, "e2e-artifacts", "lifecycle");
    mkdirSync(dir, { recursive: true });
    if (page) await page.screenshot({ path: join(dir, `${label}.png`), fullPage: true });
    try {
      const client = await readClientDump(page).catch(() => null);
      if (client) writeLifecycleArtifact(`${label}-client.json`, client);
    } catch { /* dump is best-effort */ }
    writeFileSync(join(dir, `${label}-relay.log`), `${relay?.stdout || ""}\n--- stderr ---\n${relay?.stderr || ""}`);
    if (host) {
      writeFileSync(join(dir, `${label}-host.log`), `${host.stdout || ""}\n--- stderr ---\n${host.stderr || ""}`);
    }
    log(`wrote failure artifacts under e2e-artifacts/lifecycle/${label}.*`);
  } catch (e) {
    log(`could not write failure artifacts: ${(e && e.message) || e}`);
  }
}

function installHostFrameTap() {
  if (window.__lifecycleHostFrames) return;
  window.__lifecycleHostFrames = [];
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && typeof d.type === "string") {
      const rec = { type: d.type, at: Date.now() };
      if (d.type === "error" || d.type === "userMessage") {
        if (typeof d.text === "string") rec.text = d.text;
        if (typeof d.submissionId === "string" && d.submissionId) rec.submissionId = d.submissionId;
      }
      if (d.type === "error" && typeof d.code === "string") rec.code = d.code;
      window.__lifecycleHostFrames.push(rec);
    }
  });
}

async function hostFrameCount(page) {
  return page.evaluate(() => (window.__lifecycleHostFrames || []).length);
}

async function replacementHostFramesSince(page, since) {
  return page.evaluate((n) => {
    const frames = window.__lifecycleHostFrames || [];
    return frames.slice(n).filter((f) => (
      f.type === "initialState" ||
      f.type === "clearMessages" ||
      f.type === "sessions" ||
      f.type === "session" ||
      f.type === "repos"
    )).length;
  }, since);
}

async function main() {
  const extensionRoot = resolveExtensionRoot();
  const skip = skipReason(extensionRoot);
  if (skip) {
    log(`SKIP: ${skip}`);
    if (hostRequired()) {
      throw new Error(`LIFECYCLE_REQUIRE_HOST is set but ${skip}`);
    }
    log("Exiting 0 so a bare clone's local gate stays runnable. CI sets LIFECYCLE_REQUIRE_HOST=1.");
    return 0;
  }

  if (inverted("skip-kill") || inverted("skip-admission") || inverted("forget-identity") ||
      inverted("skip-queue-send") || inverted("skip-repo-switch") || inverted("skip-offline-wait") ||
      inverted("expect-first-session")) {
    log(`INVERT active: ${[...invertSet()].join(",")}`);
  }

  ensureSiblingBuilt(extensionRoot);

  const scratch = mkdtempSync(join(tmpdir(), "afk-lifecycle-"));
  const grokHome = join(scratch, "grok-home");
  const wsAlpha = makeWorkspace(scratch, "alpha");
  const wsBravo = makeWorkspace(scratch, "bravo");
  mkdirSync(grokHome, { recursive: true });
  log(`GROK_HOME=${grokHome} (temp — never ~/.grok)`);

  const relay = spawnRelay();
  let host = null;
  const hosts = [];
  let browser = null;
  let page = null;

  const cleanup = async () => {
    try { await browser?.close(); } catch { /* */ }
    for (const h of hosts) {
      try { await killHostTree(h); } catch { /* */ }
    }
    try { relay.child.kill(); } catch { /* */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* */ }
  };

  try {
    await waitForRelayListening(relay);
    log(`relay listening on ${BASE}`);

    const { token, deviceId: approvedId } = await mintDeviceToken();
    const devicesAfterLink = await listDevices();
    const deviceId = approvedId || devicesAfterLink[0]?.deviceId;
    assert.ok(deviceId, "link handshake must produce a deviceId");
    log(`linked device ${deviceId}`);

    const hostEnv = {
      GROK_RELAY_URL: WS_BASE,
      GROK_RELAY_DEVICE_TOKEN: token,
      GROK_HOME: grokHome,
      GROK_LIFECYCLE_WORKSPACES: JSON.stringify([wsAlpha, wsBravo]),
      GROK_LIFECYCLE_READY_MS: "90000",
    };

    const attachBeforeFirst = relay.attachCount;
    host = spawnHost(extensionRoot, hostEnv);
    hosts.push(host);
    await waitForHostReadyLine(host);
    await waitForAdmission(
      relay,
      deviceId,
      attachBeforeFirst + 1,
      "relay to admit the first host (GET /api/devices online:true after READY)",
    );
    log("first host admitted");

    browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(installHostFrameTap);
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => {
      const msg = String(e && e.message || e);
      if (/Clipboard|clipboard/i.test(msg)) return;
      pageErrors.push(msg);
    });

    await page.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`, { waitUntil: "load" });
    await waitForChatUsable(page, "first connect: chat to leave Connecting");
    await waitFor(async () => {
      const n = await page.locator(".rail-repo-label").count();
      return n >= 2;
    }, "projects rail to show both workspaces", 30000);

    // 1. new session — the host already starts one on first attach. An empty
    // conversation is deliberately not written to tab identity, so we must
    // not treat a missing sessionStorage id as "no session" and click New:
    // that would spawn a second row. Wait for the painted session instead.
    await waitFor(async () => {
      const title = (await page.locator("#session-head-title").textContent().catch(() => "")) || "";
      const railRow = await page.locator(".rail-session").count();
      return (!!title.trim() && !/Connecting/i.test(title)) || railRow > 0;
    }, "host to paint a session (title or rail row)", 30000);
    const alreadyOpen = await page.locator("#session-head-title").textContent().catch(() => "");
    if (!alreadyOpen || !String(alreadyOpen).trim()) {
      await clickNewSession(page);
      await waitForChatUsable(page, "new session to finish opening");
    }
    log(`new session opened (${(alreadyOpen || "").trim() || "via New"})`);

    // 2. first alpha turn, then a second session in the same repo. Refresh
    // must restore the second, not the first — one session lets the host
    // snapshot masquerade as identity restore.
    const agentsBeforeA = (await readTranscript(page)).agents.length;
    await sendPrompt(page, PROMPT_A);
    await waitForAnsweredTurn(page, PROMPT_A, "first turn", agentsBeforeA);
    await waitFor(async () => {
      const t = await readTranscript(page);
      const welcomeHidden = await page.locator("#welcome").isHidden().catch(() => false);
      return t.users.some((u) => u.includes(PROMPT_A)) && (welcomeHidden || t.agents.some((a) => a.includes(AGENT_OK)));
    }, "first turn to stay painted (welcome dismissed or agent reply visible)", 15000);
    const sessionA1 = await readRememberedSession(page, deviceId);
    assert.ok(sessionA1 && sessionA1.id, `first turn must remember a session id, got ${JSON.stringify(sessionA1)}`);
    if (sessionA1.id === "fake-session-1") {
      log(`note: observed constant session id ${JSON.stringify(sessionA1.id)}`);
    }
    persistTurnForLoad(grokHome, sessionA1.cwd || wsAlpha, sessionA1.id, PROMPT_A, AGENT_OK);
    log(`first turn answered; session ${sessionA1.id}`);

    await startNewSessionInRepo(page, "alpha");
    await waitFor(async () => {
      const t = await readTranscript(page);
      return !t.restoring && !t.users.some((u) => u.includes(PROMPT_A));
    }, "second alpha session to open without the first transcript", 45000);
    await waitForChatUsable(page, "second alpha session composer");
    const agentsBeforeA2 = (await readTranscript(page)).agents.length;
    await sendPrompt(page, PROMPT_A2);
    await waitForAnsweredTurn(page, PROMPT_A2, "second alpha turn", agentsBeforeA2);
    const sessionA = await readRememberedSession(page, deviceId);
    assert.ok(sessionA && sessionA.id, `second turn must remember a session id, got ${JSON.stringify(sessionA)}`);
    assert.notEqual(
      sessionA.id,
      sessionA1.id,
      `second alpha session must be a distinct id, got ${JSON.stringify(sessionA)} after ${JSON.stringify(sessionA1)}`,
    );
    persistTurnForLoad(grokHome, sessionA.cwd || wsAlpha, sessionA.id, PROMPT_A2, AGENT_OK);
    await waitFor(async () => {
      const n = await page.locator(".rail-repo").filter({
        has: page.locator(".rail-repo-label", { hasText: "alpha" }),
      }).locator(".rail-session").count();
      return n >= 2;
    }, "alpha rail to list both sessions", 20000);
    log(`second alpha turn answered; session ${sessionA.id} (first was ${sessionA1.id})`);
    const beforeReload = await readTranscript(page);
    log(`pre-refresh transcript users=${JSON.stringify(beforeReload.users)} agents=${JSON.stringify(beforeReload.agents)}`);

    // 3. tab refresh, then restore the SECOND conversation
    if (inverted("forget-identity")) {
      log("INVERT forget-identity — wiping tab session memory before refresh");
      await page.evaluate((id) => {
        sessionStorage.removeItem(`grok.remote.tabSession:${id}`);
      }, deviceId);
    }
    await page.reload({ waitUntil: "load" });
    await waitForChatUsable(page, "reloaded tab to finish identity restore");
    if (inverted("expect-first-session")) {
      await waitFor(async () => {
        const t = await readTranscript(page);
        return !t.restoring && t.users.some((u) => u.includes(PROMPT_A)) && !t.users.some((u) => u.includes(PROMPT_A2));
      }, "INVERT expect-first-session still asserts the first conversation (should go red)", 8000);
    }
    await waitFor(async () => {
      const t = await readTranscript(page);
      return !t.restoring && t.users.some((u) => u.includes(PROMPT_A2)) && t.agents.some((a) => a.includes(AGENT_OK));
    }, `reloaded tab to show the second conversation (session ${sessionA.id}), not the first (${sessionA1.id})`, 45000);
    const sessionAAfterReload = await readRememberedSession(page, deviceId);
    assert.equal(
      sessionAAfterReload && sessionAAfterReload.id,
      sessionA.id,
      `refresh must keep session ${sessionA.id}, got ${JSON.stringify(sessionAAfterReload)}`,
    );
    const afterReload = await readTranscript(page);
    assert.equal(afterReload.restoring, false, "a completed restore must lift the transcript veil");
    assert.equal(
      afterReload.users.some((u) => u.includes(PROMPT_A)),
      false,
      `refresh restored the other alpha session. users=${JSON.stringify(afterReload.users)}`,
    );
    log("refresh restored the second conversation");

    // 4–5. host restart mid-flow, then reconnect on the SAME tab.
    // Restart is the class this suite exists to pin. Repo switch comes after
    // so a fixture that still mints a constant session id cannot hide a
    // restart that never killed anything.
    let sessionB = null;
    const attachBeforeRestart = relay.attachCount;
    const oldPid = host.pid;
    const framesBeforeRestart = await hostFrameCount(page);

    if (inverted("skip-kill")) {
      log("INVERT skip-kill — leaving the first host running and spawning another");
    } else {
      await killHostTree(host);
      await waitForHostDead(relay, host, deviceId);
      assert.ok(hostProcessGone(host), "shutdown must have reaped the wrapper");
      log(`old host pid ${oldPid} is gone; uplink dropped`);
    }

    // Snapshot BEFORE the outbox can flush. Identity confirmation is the
    // same handshake that restores A2, so reading the agent count after
    // that wait treats an already-arrived queued turn as "not yet".
    const agentsWhenQueued = (await readTranscript(page)).agents.length;
    if (inverted("skip-queue-send")) {
      log("INVERT skip-queue-send — not queueing work while the host is down");
    } else {
      await sendPrompt(page, PROMPT_QUEUED);
    }

    const replacement = spawnHost(extensionRoot, hostEnv);
    hosts.push(replacement);
    await waitForHostReadyLine(replacement);
    if (!inverted("skip-kill")) {
      assert.notEqual(replacement.pid, oldPid, "replacement host must be a new process");
    }
    await waitForAdmission(
      relay,
      deviceId,
      attachBeforeRestart + 1,
      "relay to admit the replacement host (not a 4002-rejected READY, not the old zombie)",
      60000,
    );
    host = replacement;
    log("replacement host admitted");

    await waitFor(
      async () => (await replacementHostFramesSince(page, framesBeforeRestart)) >= 1,
      "a frame from the replacement host (initialState/sessions/repos/clearMessages) — stale DOM is not a reconnect",
      30000,
    );
    await waitForChatUsable(page, "same tab to become usable after host restart");
    await waitFor(async () => {
      const t = await readTranscript(page);
      const s = await readRememberedSession(page, deviceId);
      return t.restoring === false &&
        s && s.id === sessionA.id &&
        t.users.some((u) => u.includes(PROMPT_A2));
    }, `replacement host to restore the owned conversation (session ${sessionA.id}), not a boot-gap empty session`, 45000);

    const afterRestart = await readTranscript(page);
    assert.equal(afterRestart.restoring, false, "tab must not stay veiled after the host returns");
    assert.equal(
      afterRestart.users.some((u) => u.includes(PROMPT_A)),
      false,
      `after restart the tab restored the first alpha session instead of the one it owned. users=${JSON.stringify(afterRestart.users)}`,
    );

    const defects = [];
    if (!inverted("skip-queue-send")) {
      try {
        const outcome = await waitForVisibleFailureOrArrival(
          page,
          PROMPT_QUEUED,
          "queue release after restart",
          agentsWhenQueued,
          framesBeforeRestart,
        );
        const finalT = await readTranscript(page);
        const frames = await hostFramesSince(page, framesBeforeRestart);
        const classified = classifyQueueRelease(finalT, PROMPT_QUEUED, agentsWhenQueued, frames);
        try {
          writeLifecycleArtifact("queue-release-client.json", {
            outcome,
            classified,
            agentsWhenQueued,
            transcript: finalT,
            errorFrames: frames.filter((f) => f && f.type === "error"),
            client: await readClientDump(page).catch(() => null),
          });
        } catch { /* diagnostic */ }
        log(`queued work while host was down: ${outcome}`);
        if (!classified) {
          defects.push(
            `queued work ${JSON.stringify(PROMPT_QUEUED)} was silently dropped after restart. ` +
              `transcript=${JSON.stringify(finalT)}`,
          );
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        log(`queued check failed (isolation still runs): ${msg}`);
        try {
          const t = await readTranscript(page);
          const frames = await hostFramesSince(page, framesBeforeRestart);
          writeLifecycleArtifact("queue-release-client.json", {
            outcome: "timeout",
            classified: classifyQueueRelease(t, PROMPT_QUEUED, agentsWhenQueued, frames),
            agentsWhenQueued,
            transcript: t,
            errorFrames: frames.filter((f) => f && f.type === "error"),
            client: await readClientDump(page).catch(() => null),
          });
        } catch { /* diagnostic */ }
        defects.push(msg);
      }
    } else {
      await waitFor(async () => {
        const t = await readTranscript(page);
        return queuedTurnArrived(t, PROMPT_QUEUED, agentsWhenQueued);
      }, "INVERT skip-queue-send still asserts the unsent prompt arrived (should go red)", 8000);
    }

    const sessionAfterRestart = await readRememberedSession(page, deviceId);
    assert.ok(sessionAfterRestart && sessionAfterRestart.id, "session id must survive the restart");
    assert.equal(
      sessionAfterRestart.id,
      sessionA.id,
      `session id after restart must stay ${sessionA.id}, got ${JSON.stringify(sessionAfterRestart)}`,
    );
    log("restart reconnect kept the conversation and session id");

    // 6. repo switch — two workspaces, no bleed. The rail "+" on another
    // project is two host operations; waitForRailPlusSettled is the bind
    // signal, not the composer (already usable on the conversation we leave).
    if (inverted("skip-repo-switch")) {
      log("INVERT skip-repo-switch — staying on the first repo");
      sessionB = sessionA;
      assert.notEqual(
        sessionB.id,
        sessionA.id,
        "INVERT: isolation asserted without switching (must go red)",
      );
    } else {
      const framesBeforeBravoPlus = await hostFrameCount(page);
      await startNewSessionInRepo(page, "bravo");
      await waitForRailPlusSettled(page, {
        previousPrompts: [PROMPT_A, PROMPT_A2],
        framesBeforeClick: framesBeforeBravoPlus,
        where: "bravo new session to bind — previous transcript must leave and the follow-up newSession must settle",
      });
      await waitForChatUsable(page, "bravo new session composer");
      const afterSwitch = await readTranscript(page);
      sessionB = await readRememberedSession(page, deviceId);
      const headerAfterSwitch = (await page.locator("#session-head-title").textContent().catch(() => "")) || "";
      if (
        afterSwitch.users.some((u) => u.includes(PROMPT_A)) ||
        afterSwitch.users.some((u) => u.includes(PROMPT_A2))
      ) {
        throw new Error(describeIsolationMismatch({
          expectedRepo: "bravo",
          remembered: sessionB,
          previousId: sessionA.id,
          users: afterSwitch.users,
          title: headerAfterSwitch,
        }));
      }
      const agentsBeforeB = afterSwitch.agents.length;
      await sendPrompt(page, PROMPT_B);
      await waitForAnsweredTurn(page, PROMPT_B, "bravo turn", agentsBeforeB);
      sessionB = await readRememberedSession(page, deviceId);
      assert.ok(sessionB && sessionB.id, "bravo must remember a session id");
      assert.notEqual(
        sessionB.id,
        sessionA.id,
        describeIsolationMismatch({
          expectedRepo: "bravo",
          remembered: sessionB,
          previousId: sessionA.id,
          users: (await readTranscript(page)).users,
          title: (await page.locator("#session-head-title").textContent().catch(() => "")) || "",
        }),
      );
      persistTurnForLoad(grokHome, sessionB.cwd || wsBravo, sessionB.id, PROMPT_B, AGENT_OK);
      const bravoT = await readTranscript(page);
      assert.equal(
        bravoT.users.some((u) => u.includes(PROMPT_A)) || bravoT.users.some((u) => u.includes(PROMPT_A2)),
        false,
        `bravo transcript must not show alpha's prompt (bleed). users=${JSON.stringify(bravoT.users)}`,
      );
      log(`repo switch isolated; bravo session ${sessionB.id}`);

      await resumeRepoSession(page, "alpha", PROMPT_A2);
      await waitFor(async () => {
        const t = await readTranscript(page);
        const s = await readRememberedSession(page, deviceId);
        return s && s.id === sessionA.id && t.users.some((u) => u.includes(PROMPT_A2));
      }, "switching back to alpha to restore its second conversation, not bravo's", 30000);
      const back = await readTranscript(page);
      assert.equal(
        back.users.some((u) => u.includes(PROMPT_B)),
        false,
        `alpha transcript must not show bravo's prompt after switch-back. users=${JSON.stringify(back.users)}`,
      );
      log("switched back; alpha conversation intact");
    }

    assert.deepEqual(pageErrors, [], `page logged errors — ${JSON.stringify(pageErrors)}`);
    if (defects.length) {
      throw new Error(defects.join("\n"));
    }
    log("ALL CHECKS PASSED");
    return 0;
  } catch (e) {
    log(`FAILED: ${(e && e.message) || e}`);
    await dumpFailure(page, relay, host, "fail");
    throw e;
  } finally {
    await cleanup();
  }
}

if (launchedDirectly()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      process.stderr.write(`[lifecycle] ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}
