// Does a cloud environment actually work?
//
// One question, answered end to end: start a relay, mint a device token, run
// the real desktop host in a Linux container with no display, and drive it from
// a browser. If the chat comes up and the container's own filesystem changes in
// response to something clicked in that browser, the product shape is real.
//
// This is the spike's whole point. Every plan for managed environments assumed
// "the desktop app under Xvfb already works", and the only evidence anyone had
// pointed the other way: the relay's CI ran that app on ubuntu-latest four
// times and it failed four times.
//
// Run: node cloud/verify.mjs        (after: node cloud/build.mjs)
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.CLOUD_PORT || 8802);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = process.env.CLOUD_TAG || "afkpilot-cloud:dev";
const NAME = "afkpilot-cloud-verify";
const OUT = join(process.env.SCREENS_DIR || ".screens", "cloud");
const log = (m) => console.log(`[cloud] ${m}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const waitFor = async (fn, what, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const postJson = async (p, body) =>
  (await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

// The container reaches the host through this name on Docker Desktop. Which
// means the relay has to listen on more than loopback — it is a keyless mock
// relay on a high port for the length of one run, and it is torn down below.
const RELAY_HOST = "0.0.0.0";
const FROM_CONTAINER = `ws://host.docker.internal:${PORT}`;

let relay, browser, containerUp = false;
const stopContainer = () => {
  try { execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" }); } catch { /* not running */ }
};

try {
  stopContainer();

  relay = spawn(process.execPath, ["dist/main.js"], {
    env: {
      ...process.env,
      RELAY_HOST, RELAY_PORT: String(PORT),
      CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (d) => { relayLog += d; });
  relay.stderr.on("data", (d) => { relayLog += d; });

  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, "the relay to listen");
  log(`relay on ${PORT}`);

  // A managed environment would be minted this way too — the relay creates the
  // device on behalf of a user who is already signed in, and hands the token to
  // the machine as a secret. Nothing here is standing in for an interactive
  // link that a container could not do; there simply is no interactive step.
  const started = await postJson("/api/link/start", { name: "Cloud — Pawel" });
  await postJson("/api/link/approve", { code: started.code });
  const token = (await postJson("/api/link/poll", { code: started.code })).token;
  assert.ok(token, "the relay must mint a device token");
  log("device token minted");

  const args = [
    "run", "--rm", "--name", NAME,
    "-e", `GROK_RELAY_URL=${FROM_CONTAINER}`,
    "-e", `GROK_RELAY_DEVICE_TOKEN=${token}`,
    "--add-host", "host.docker.internal:host-gateway",
    TAG,
  ];
  const container = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  containerUp = true;
  let clog = "";
  const absorb = (d) => {
    clog += d;
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim()) console.log(`  | ${line}`);
    }
  };
  container.stdout.on("data", absorb);
  container.stderr.on("data", absorb);
  container.on("close", (code) => { containerUp = false; log(`container exited (${code})`); });

  // THE assertion, and it must be `online` — nothing weaker.
  //
  // A device ROW exists from the moment the token is minted, so `list[0]` is
  // satisfied by a container that never started. `online` is
  // `hub.uplinkConnected(deviceId)` (server.ts:630) — live socket state, and the
  // only thing here that means the host dialled out from a machine with no
  // display and no keyboard.
  const device = await waitFor(async () => {
    if (!containerUp) throw new Error(`the container exited before linking:\n${clog.slice(-3000)}`);
    try {
      const list = (await (await fetch(`${BASE}/api/devices`)).json()).devices || [];
      return list.find((d) => d.online);
    } catch { return undefined; }
  }, "the container's uplink to connect", 120000);
  log(`linked and online: ${device.name} (${device.deviceId})`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.stack || e)));
  await page.goto(`${BASE}/chat?device=${encodeURIComponent(device.deviceId)}&linked=1`, { waitUntil: "load" });

  // The composer is NOT proof — it renders before any snapshot arrives. What
  // only a live host produces is the empty state it sends: a container with no
  // agent connected reports `onboarding`, and that frame cannot come from
  // anywhere else.
  await waitFor(
    async () => (await page.locator("#welcome-onboarding").innerText().catch(() => "")).trim().length > 0,
    "an empty-state frame from the container",
    60000,
  );
  const panel = (await page.locator("#welcome-onboarding").innerText()).replace(/\s+/g, " ").trim();
  log(`the container says: ${panel.slice(0, 90)}`);
  await page.screenshot({ path: join(OUT, "1-attached.png") });

  // And the strongest proof available: click through the real UI here, and watch
  // the CONTAINER's filesystem change. A snapshot could in principle be a
  // replayed fixture; a directory that did not exist a second ago cannot be.
  //
  // Driven the way a person would — open the rail, Add a project, New project,
  // type a name — rather than by posting a message. That exercises the actual
  // capability path (`createProject`, which is remote-safe because it takes a
  // NAME and lets the host decide where it goes) instead of a shortcut past it.
  const project = `verified-${device.deviceId.slice(0, 6)}`;
  log(`creating "${project}" through the rail`);

  // On a phone the rail is a drawer and its Add-project button is present but
  // HIDDEN — a locator that only checks existence waits 20s on an invisible
  // element and then blames the feature. #rail-open is the control that opens it.
  const railOpen = page.locator('#rail-open');
  if (await railOpen.isVisible().catch(() => false)) {
    await railOpen.click();
    await page.locator('#projects-rail').waitFor({ state: 'visible', timeout: 10000 });
  }
  const addProject = page.locator(".rail-empty-action, .rail-add-project").first();
  await addProject.waitFor({ state: "visible", timeout: 20000 });
  await addProject.click();

  // A host that offers only ONE way in shows no menu at all and opens the form
  // directly — which is what a container does: it advertises `createProject`
  // and `cloneProject` but not the native folder picker, and in Knowledge mode
  // that leaves one. Handle both rather than assuming the menu.
  const newProject = page.locator(".rail-menu-item", { hasText: /new project/i }).first();
  if (await newProject.isVisible().catch(() => false)) {
    await newProject.click();
  } else {
    const items = await page.locator(".rail-menu-item").allInnerTexts().catch(() => []);
    log("no menu — the host offers one way in, so the form opened directly"
      + (items.length ? ` (menu items: ${items.length})` : ""));
  }

  const nameInput = page.locator(".add-project-input").first();
  await nameInput.waitFor({ state: "visible", timeout: 10000 });
  await nameInput.fill(project);
  await page.locator(".add-project-primary").first().click();

  const listing = await waitFor(async () => {
    try {
      const out = execFileSync("docker", ["exec", NAME, "ls", "-1", "/data/Grok Build"], { encoding: "utf8" });
      return out.includes(project) ? out : undefined;
    } catch { return undefined; }
  }, "the project directory to appear inside the container", 60000);

  log(`the container's own filesystem changed:`);
  for (const line of listing.trim().split(/\r?\n/)) log(`  /data/Grok Build/${line}`);
  await page.screenshot({ path: join(OUT, "2-project-created.png") });

  assert.deepEqual(pageErrors, [], "the page must throw nothing");
  log("ALL CHECKS PASSED");
  log(`screens in ${OUT}`);
} finally {
  try { await browser?.close(); } catch { /* */ }
  stopContainer();
  relay?.kill();
}
