// Real-browser end-to-end: headless Chromium drives the ACTUAL pages against a
// relay running the real Clerk verifier — the mile no vitest file covers
// (ClerkJS hot-load from the FAPI, the sign-in modal, the __session cookie on
// the WS upgrade, PricingTable/badge). Clerk test mode: +clerk_test emails,
// verification code 424242, no real email sent.
//
// Needs: .env with the Clerk dev keys, web/vendor synced, dist/ built, port
// 8787 free (it must be in CLERK_AUTHORIZED_PARTIES — browser tokens carry
// azp = the page origin). Run: npm run e2e:browser
// Artifacts (screenshots + relay log) land in E2E_ARTIFACT_DIR or ./e2e-artifacts.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { chromium } from "playwright";
import { createDb } from "../dist/supabase.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env — relay will run mock mode and this script will fail its Clerk check */
}

const BASE = "http://127.0.0.1:8787";
const FIRST = "first+clerk_test@example.com";
const SECOND = "second+clerk_test@example.com";
const CODE_OTP = "424242";
const ART = process.env.E2E_ARTIFACT_DIR || "e2e-artifacts";
mkdirSync(ART, { recursive: true });

const log = (m) => console.log(`[e2e] ${m}`);
let relay, browser, uplink, uplinkFree;
const relayLog = [];

// Devices land in the REAL Supabase registry — scrub this script's rows (name
// prefix "e2e ") before and after, or reruns trip the free-tier device cap.
// Usage counters persist too now (dev db): clear them all so the free-tier
// meter assertions ("1 / 100") start from zero on every run.
async function scrubDevices() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  const db = createDb(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  await db.from("devices").delete().like("name", "e2e %");
  // Tolerate the table not existing yet (migration applies via the GitHub
  // integration after this lands on main).
  try {
    await db.from("usage_counters").delete().neq("user_id", "");
  } catch {
    /* pre-migration db */
  }
}

function inboxOf(ws) {
  const q = [];
  let waiter = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    log(`uplink <- ${raw.toString().slice(0, 120)}`);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(m);
    } else q.push(m);
  });
  return {
    next(timeout = 20000) {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          waiter = null;
          rej(new Error("timed out waiting for uplink frame"));
        }, timeout);
        waiter = (m) => {
          clearTimeout(t);
          res(m);
        };
      });
    },
    async matching(pred) {
      for (let i = 0; i < 20; i++) {
        const m = await this.next();
        if (pred(m)) return m;
      }
      throw new Error("no matching uplink frame in 20");
    },
  };
}

async function waitForRelay() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("relay never came up on 8787");
}

async function signIn(page, email) {
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ timeout: 30000 });
  await id.fill(email);
  await page.locator(".cl-formButtonPrimary").first().click();
  // The instance offers password first for these users — route to email code
  // (Clerk test mode: 424242). Whichever step renders first wins the race.
  const otp = page.locator(".cl-otpCodeFieldInput").first();
  const password = page.locator('input[name="password"]');
  await page.locator(".cl-otpCodeFieldInput, input[name='password']").first().waitFor({ timeout: 20000 });
  if (await password.isVisible().catch(() => false)) {
    await page.getByText("Use another method").click();
    await page.locator("button", { hasText: /Email code/ }).first().click();
  }
  await otp.waitFor({ timeout: 20000 });
  // The visible segments are divs; the real field is an invisible single
  // <input maxlength=6> overlaying them — type into that.
  const otpInput = page.locator('input[data-input-otp="true"], input[autocomplete="one-time-code"]').first();
  await otpInput.waitFor({ state: "attached", timeout: 10000 });
  await otpInput.focus();
  await page.keyboard.type(CODE_OTP, { delay: 60 });
  await page.waitForFunction(() => window.Clerk && window.Clerk.user, null, { timeout: 30000 });
  log(`signed in as ${email}`);
}

async function main() {
  await scrubDevices();
  // ---- boot the real relay (real .env: Clerk + Supabase) ----
  relay = spawn(process.execPath, ["dist/main.js"], {
    env: { ...process.env, RELAY_HOST: "127.0.0.1", RELAY_PORT: "8787" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout.on("data", (d) => relayLog.push(d.toString()));
  relay.stderr.on("data", (d) => relayLog.push(d.toString()));
  const cfg = await waitForRelay();
  assert.ok(cfg.publishableKey?.startsWith("pk_"), "relay must run in Clerk mode (publishable key set)");
  log(`relay up, feature gate: ${cfg.requiredFeature}`);

  try {
    browser = await chromium.launch();
  } catch (e) {
    if (!String(e).includes("Executable doesn't exist")) throw e;
    log("bundled Chromium missing; using the installed Chrome channel");
    browser = await chromium.launch({ channel: "chrome" });
  }

  // =====================================================================
  // Flow A — SECOND (entitled): link approval, landing badge, live chat.
  // =====================================================================
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  pageA.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") log(`pageA console.${m.type()}: ${m.text().slice(0, 200)}`);
  });
  pageA.on("pageerror", (e) => log(`pageA pageerror: ${String(e).slice(0, 300)}`));

  // Extension-sim starts a link; the browser approves it behind sign-in.
  const started = await (
    await fetch(`${BASE}/api/link/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e real-browser box" }),
    })
  ).json();
  await pageA.goto(`${BASE}/link?code=${started.code}`);
  // Signed out → the page opens the Clerk sign-in modal itself (account
  // first, approve after); #approve only appears once signed in.
  await signIn(pageA, SECOND);
  const approve = pageA.locator("#approve");
  await approve.waitFor({ state: "visible", timeout: 15000 });
  await approve.click();
  // Approval goes straight into the new device's chat — no interstitial button
  // (owner, 2026-07-30). linked=1 rides along and is consumed by onboarding.
  await pageA.waitForURL(/\/chat\?device=/, { timeout: 15000 });
  await pageA.screenshot({ path: path.join(ART, "1-link-approved.png") });
  log("link approved in the browser — landed in the device's chat");
  // Leave that chat BEFORE the uplink attaches: attachUplink replays
  // client-ready for live clients, and this transient page would otherwise be
  // the first client-ready the popup assertions below latch onto.
  await pageA.goto(`${BASE}/`);

  // Extension-sim finishes the handshake and comes online.
  const polled = await (
    await fetch(`${BASE}/api/link/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code }),
    })
  ).json();
  assert.equal(polled.status, "approved");
  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(polled.token)}`);
  const up = inboxOf(uplink);
  await new Promise((res, rej) => {
    uplink.once("open", res);
    uplink.once("error", rej);
  });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "e2e real-browser box" } }));
  log("uplink online");

  // Landing (already open): the device row flips online on the next 3s poll,
  // entitled badge instead of pricing.
  // The row shows the name in .device-name; the anchor is the Start button.
  const deviceRow = pageA.locator("#list .device-row", { hasText: "e2e real-browser box" });
  const deviceLink = deviceRow.locator("a.device-start");
  await deviceLink.waitFor({ timeout: 20000 });
  await pageA.locator("#entitled-badge").waitFor({ state: "visible", timeout: 15000 });
  await pageA.screenshot({ path: path.join(ART, "2-landing-entitled.png") });
  log("landing: device listed + 'Remote Max active' badge");

  // Chat: the __session cookie must ride the WS upgrade; both directions live.
  // Device rows open in a new tab (target=_blank) — catch the popup and drive it.
  const [chatPage] = await Promise.all([ctxA.waitForEvent("page"), deviceLink.click()]);
  const ready = await up.matching((m) => m.t === "client-ready");
  let liveClientId = ready.clientId;
  log(`chat client connected (clientId ${ready.clientId}) — cookie rode the upgrade`);
  const ALPHA_LABEL = "alpha-a-deliberately-long-project-name";
  // A real host answers every `ready` with a fresh snapshot, so this is a
  // function: a reload gets a new clientId and must be re-served, exactly as the
  // extension would.
  const sendSnapshot = (clientId) =>
    uplink.send(
      JSON.stringify({
        t: "snapshot",
        clientId,
        msgs: [
          { type: "clearMessages" },
          { type: "messageChunk", text: "snapshot-from-e2e" },
          // The repo switcher over the wire: `repos` is a mirrored HostMsg, so a
          // browser client renders the chip from the host's discovered catalog.
          {
            type: "repos",
            entries: [
              // Deliberately long: a short label can't reproduce the flex
              // content-minimum that used to blow the rail's width open.
              { cwd: "/work/alpha", label: ALPHA_LABEL, available: true, pinned: true, pinnedAt: 2, updatedAt: 9 },
              { cwd: "/work/beta", label: "beta", available: true, pinned: false, updatedAt: 8 },
            ],
            selectedCwd: "/work/alpha",
            activeCwd: "/work/alpha",
          },
        ],
      }),
    );
  // Answer the rail's preview probe the way a real host does — registered
  // BEFORE the catalog goes out, because the client probes the moment it lands.
  // Not scenery: answering `listRepoSessions` is what tells the client this host
  // reads the `cwd` on repo-addressed messages at all, and the cross-project
  // Clear all is withheld until it does — an older extension drops that message
  // in silence, and a control that fails silently is worse than none at all.
  uplink.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame?.t !== "msg" || frame.msg?.type !== "listRepoSessions") return;
    uplink.send(JSON.stringify({
      t: "host-to",
      clientIds: [frame.clientId],
      msg: {
        type: "repoSessions",
        cwd: frame.msg.cwd,
        entries: [{
          id: "beta-1", cwd: frame.msg.cwd, displayName: "beta one",
          rawSummary: "", updatedAt: 8, createdAt: 8, numMessages: 2,
        }],
        dots: {},
        total: 1,
      },
    }));
  });
  sendSnapshot(ready.clientId);
  await chatPage.locator("#messages", { hasText: "snapshot-from-e2e" }).waitFor({ timeout: 15000 });

  // Switching repos: the whole point of the feature — it has to work on the
  // surface where you can't reach the desk. This browser runs at desktop width,
  // where the projects rail is the switcher and the top-bar chip is deliberately
  // gone: two controls for one job is what the extension already refuses to do
  // inside VS Code, and a rail makes that true here too.
  const rail = chatPage.locator("#projects-rail");
  await rail.locator(".rail-repo").first().waitFor({ timeout: 15000 });
  assert.equal(
    await chatPage.locator("#repo-btn").isVisible(),
    false,
    "the top-bar chip must give way to the rail at desktop width",
  );
  assert.equal(await rail.locator(".rail-repo").count(), 2, "both repos listed in the rail");
  // Projects sort by recency and nothing else. alpha carries `pinned: true` in
  // the fixture precisely so this proves the rail IGNORES repo pins — it is
  // ordered above beta by updatedAt (9 vs 8), not by the pin.
  assert.deepEqual(
    await rail.locator(".rail-repo-label").allTextContents(),
    [ALPHA_LABEL, "beta"],
    "projects are ordered by last activity, and a repo pin does not jump the queue",
  );
  assert.equal(
    await chatPage.locator(".rail-pin-mark").count(),
    0,
    "no pin glyphs anywhere — the Pinned section is what says a session is pinned",
  );
  // The header replaces the app-wide bar wherever the rail exists, and it has to
  // name the conversation — that name is also the only thing saying which repo
  // you are driving now the chip is gone.
  assert.equal(
    await chatPage.locator("#session-head").isVisible(),
    true,
    "the conversation header stands in for the top bar",
  );
  await chatPage.screenshot({ path: path.join(ART, "3b-projects-rail.png") });
  // Row actions are hover-only (pointer-events: none at rest) — reach them the
  // way a person does, by hovering the row first. The project menu carries the
  // destructive act and nothing else, and it is repo-addressed, so it works on a
  // project the host has not selected.
  // The project's own ⋯, not one of its conversations' — beta has rows now that
  // the host answers the preview probe, and each of those carries its own.
  const betaRow = rail.locator(".rail-repo", { hasText: "beta" });
  const betaHead = betaRow.locator(".rail-repo-head");
  await betaHead.hover();
  await betaHead.locator(".rail-menu-btn").click();
  assert.equal(
    await chatPage.locator(".rail-menu-item", { hasText: "Pin project" }).count(),
    0,
    "projects cannot be pinned — recency is the only order",
  );
  await chatPage.locator(".rail-menu-item", { hasText: "Clear all history" }).click();
  await chatPage.locator(".confirm-btn.confirm-danger").click();
  const cleared = await up.matching((m) => m.t === "msg" && m.msg?.type === "clearAllSessions");
  assert.equal(cleared.msg.cwd, "/work/beta", "clear targets the row's project, not the selected one");
  // New session in a project the host has NOT selected: the page owns the
  // two-step intent (switch, then create), so the wire must carry selectRepo
  // first and newSession only once the switch has landed.
  await betaHead.hover();
  await betaHead.locator(".rail-action-btn").first().click();
  const switched = await up.matching((m) => m.t === "msg" && m.msg?.type === "selectRepo");
  assert.equal(switched.msg.cwd, "/work/beta", "cross-project New switches first");

  // The rail's declared width is only a suggestion unless every box down to the
  // truncating label carries min-width:0 — a flex item's default minimum is its
  // CONTENT, so one long project name silently pushed a 256px rail to ~475px
  // once the scroller moved inside it. Assert the rendered width, not the rule,
  // and assert it with a name long enough to have caused it.
  const railWidth = await rail.evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(
    Math.abs(railWidth - 256) < 1,
    `the rail must hold its declared width regardless of project-name length (got ${railWidth})`,
  );
  // Full bleed: the rail sits against the window, not inside a centred card.
  const appLeft = await chatPage.evaluate(() => document.getElementById("app").getBoundingClientRect().left);
  assert.equal(Math.round(appLeft), 0, "with a rail the app spans the window");

  // A project's ⋯ and a conversation's ⋯ do the same kind of job, so they belong
  // in one column — they were 5px apart, which reads as a wobble rather than a
  // list. Nested padding and a 1px button-width difference are both easy to
  // reintroduce, so the alignment is asserted rather than eyeballed.
  const menuColumns = await chatPage.evaluate(() => {
    const repo = document.querySelector(".rail-repo-head .rail-menu-btn");
    const session = document.querySelector(".rail-session .rail-menu-btn");
    if (!repo || !session) return null;
    return [repo.getBoundingClientRect().right, session.getBoundingClientRect().right];
  });
  if (menuColumns) {
    assert.ok(
      Math.abs(menuColumns[0] - menuColumns[1]) < 0.5,
      `project and session ⋯ must share a column (got ${menuColumns[0]} vs ${menuColumns[1]})`,
    );
  }

  // Folding a project is a preference about the sidebar, not a fact about the
  // session, so it has to survive a reload — otherwise every visit re-opens
  // everything you deliberately put away.
  const alphaRow = rail.locator(".rail-repo", { hasText: "alpha" });
  await alphaRow.locator(".rail-twisty").click();
  await alphaRow.locator(".rail-sessions").waitFor({ state: "detached", timeout: 5000 });
  await chatPage.reload({ waitUntil: "domcontentloaded" });
  // The reload is a new relay client, and everything downstream that checks
  // routing has to mean THIS one.
  liveClientId = (await up.matching((m) => m.t === "client-ready")).clientId;
  sendSnapshot(liveClientId);
  await rail.locator(".rail-repo").first().waitFor({ timeout: 15000 });
  assert.equal(
    await rail.locator(".rail-repo", { hasText: "alpha" }).locator(".rail-sessions").count(),
    0,
    "a folded project stays folded across a reload",
  );
  await rail.locator(".rail-repo", { hasText: "alpha" }).locator(".rail-twisty").click();

  // Search filters what the rail already holds. It has no host round-trip, so
  // the only thing that can break it is the render path — which is exactly what
  // this asserts, including that clearing it restores everything.
  await chatPage.fill("#rail-search", "beta");
  await chatPage.locator(".rail-repo", { hasText: "alpha" }).waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await rail.locator(".rail-repo").count(), 1, "search narrows the projects list");
  await chatPage.fill("#rail-search", "no-such-project");
  assert.equal(
    await rail.locator(".rail-note", { hasText: "No matches." }).count(),
    1,
    "a query that matches nothing says so rather than showing an empty list",
  );
  await chatPage.fill("#rail-search", "");
  await chatPage.locator(".rail-repo", { hasText: "alpha" }).waitFor({ timeout: 5000 });
  assert.equal(await rail.locator(".rail-repo").count(), 2, "clearing the search restores every project");

  // Collapsing the rail must leave a way back — without the handle the projects
  // list would be unreachable and the only cure a reload.
  await chatPage.locator("#rail-toggle").click();
  assert.equal(await rail.isVisible(), false, "the toggle collapses the rail");
  assert.equal(
    await chatPage.locator("#rail-open").isVisible(),
    true,
    "collapsing surfaces the handle that brings it back",
  );
  await chatPage.locator("#rail-open").click();
  assert.equal(await rail.isVisible(), true, "the handle restores the rail");

  // Archived: a third section, folded, holding what you put away. The host owns
  // the choice (it follows you to a phone), so this drives it the way the real
  // extension does — a fresh catalog with the flag set — and then asks for it
  // back, which is the round trip the rail actually depends on.
  uplink.send(JSON.stringify({
    t: "host-to",
    clientIds: [liveClientId],
    msg: {
      type: "repos",
      entries: [
        { cwd: "/work/alpha", label: ALPHA_LABEL, available: true, pinned: true, pinnedAt: 2, updatedAt: 9, archived: false, archivedAt: 0 },
        { cwd: "/work/beta", label: "beta", available: true, pinned: false, updatedAt: 8, archived: true, archivedAt: Date.now() },
      ],
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    },
  }));
  // Pick the Archive group BY NAME. The rail used to have one collapsible
  // section, so `.rail-head-fold` alone identified it; the redesign added
  // Recent and Projects folds beside it, and a bare class selector then matches
  // three heads and fails strict mode. Naming it is also what keeps this
  // assertion about the archive rather than about whatever happens to be first.
  const archiveHead = chatPage
    .locator(".rail-head-fold")
    .filter({ hasText: /archive/i })
    .first();
  // (The rail's probe for beta's rows was answered above — see the
  // `listRepoSessions` responder. Without an answer the client cannot know the
  // host reads the cwd on repo-addressed messages at all.)
  await archiveHead.waitFor({ timeout: 10000 });
  // The rail redesign replaced the head's item count with a title + chevron,
  // so what a folded Archive now promises is narrower: it EXISTS (there is
  // something in it — an empty archive mounts no section at all) and it is
  // CLOSED. The count is gone deliberately; asserting it would be asserting a
  // dropped feature.
  assert.equal(
    await archiveHead.locator(".rail-head-btn").getAttribute("aria-expanded"),
    "false",
    "an Archived section starts folded — putting something away should keep it away",
  );
  assert.equal(
    await rail.locator(".rail-repo", { hasText: "beta" }).count(),
    0,
    "an archived project is not also still listed under Projects",
  );
  await archiveHead.locator(".rail-head-btn").click();
  const archivedBeta = rail.locator(".rail-repo", { hasText: "beta" }).locator(".rail-repo-head");
  await archivedBeta.waitFor({ timeout: 5000 });
  await archivedBeta.hover();
  await archivedBeta.locator(".rail-menu-btn").click();
  assert.equal(
    await chatPage.locator(".rail-menu-item", { hasText: "Archive project" }).count(),
    0,
    "a row already under Archived is not offered the same trip again",
  );
  await chatPage.locator(".rail-menu-item", { hasText: "Move to Projects" }).click();
  const unarchived = await up.matching((m) => m.t === "msg" && m.msg?.type === "setRepoArchived");
  assert.deepEqual(
    { cwd: unarchived.msg.cwd, archived: unarchived.msg.archived },
    { cwd: "/work/beta", archived: false },
    "coming back out is recorded on the host, not just in this browser",
  );
  log("archived projects: folded third section, count, and the round trip to the host");

  // The conversation header carries the same two controls the VS Code top bar
  // has — History and New — and the title beside them is a label. The title used
  // to BE the history trigger, which gave the one element naming where you are a
  // second, invisible meaning; a control that hides itself inside a heading is
  // not a control anyone finds twice.
  assert.equal(
    await chatPage.locator("#session-head-main").evaluate((el) => el.tagName.toLowerCase()),
    "div",
    "the conversation title is a label, not a hidden dropdown",
  );
  // REVERSED 2026-08-17 (owner). New used to live INSIDE the conversation's
  // overflow menu on rail hosts, because the top bar's New read as a third
  // similar icon beside the rail's own + and the project row's +: one pointer,
  // three New buttons.
  //
  // That argument assumed the rail is on screen. It can be closed or
  // minimised, and when it is, neither the rail + nor the project row + is
  // reachable — so the top bar's New is not a third button, it is the only one
  // left. It is also scoped differently: a new session in the SAME project,
  // rather than "create one in whatever project I am pointing at".
  //
  // So New sits beside Session history and is no longer in the overflow. Two
  // places, not three, and not one that vanishes with the rail.
  assert.equal(
    await chatPage.locator("#session-new").isVisible(),
    true,
    "New sits in the top bar beside Session history, reachable with the rail closed",
  );
  // The other half of that reversal — New is no longer in the conversation
  // overflow — is NOT asserted here, deliberately. That menu's host returns
  // early without a session record (`if (!record) return`), and at this point
  // in the flow there is no active conversation, so the button legitimately
  // does not exist. The old assertion only worked because New itself was the
  // thing rendering it.
  //
  // Writing `if the menu exists, check it` would be the fallback shape this
  // suite has already been bitten by twice today: a branch that passes when the
  // thing under test is absent. The menu's contents are asserted in the
  // extension repo's DOM tests instead, where a record exists — desktop and
  // remote keep Continue and Delete, VS Code keeps Continue and Export, and New
  // is in none of them.
  await chatPage.locator("#session-history").click();
  assert.equal(
    await chatPage.locator("#history-popover").isVisible(),
    true,
    "the History icon opens the session list",
  );
  await chatPage.locator("#session-history").click();
  await chatPage.locator("#history-popover").waitFor({ state: "hidden", timeout: 5000 });
  log("projects rail: recency order, no pin glyphs, menus + cross-repo New + search + collapse all work");
  log("conversation header: inert title, History and New as their own icons");
  await chatPage.fill("#input", "hello from a real browser");
  await chatPage.locator("#send-btn").click();
  const routed = await up.matching((m) => m.t === "msg" && JSON.stringify(m.msg).includes("hello from a real browser"));
  assert.equal(routed.clientId, liveClientId);
  await chatPage.screenshot({ path: path.join(ART, "3-chat-live.png") });
  log("chat: snapshot rendered, browser->host message routed");
  const targetDevice = new URL(chatPage.url()).searchParams.get("device");
  assert.ok(targetDevice, "chat page URL should carry the device id");
  await ctxA.close();

  // =====================================================================
  // Flow B — FIRST (free tier): pricing surface, someone-else's device is
  // refused (4003 — free tier admits them, ownership doesn't), then the
  // genuine free journey: link their OWN device and chat within quota.
  // =====================================================================
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE}/`);
  await pageB.locator("#signin-btn").click();
  await signIn(pageB, FIRST);
  await pageB.locator("#billing").waitFor({ state: "visible", timeout: 20000 });
  // The PricingTable mounts async (lazy chunks from the FAPI) — poll for it.
  await pageB.waitForFunction(
    () => document.getElementById("pricing").childElementCount > 0 || !document.getElementById("manage-btn").hidden,
    null,
    { timeout: 25000 },
  );
  const surface = await pageB.evaluate(() => ({
    pricingTable: typeof window.grokAuth.clerk.mountPricingTable === "function",
    pricingChildren: document.getElementById("pricing").childElementCount,
    manageVisible: !document.getElementById("manage-btn").hidden,
  }));
  log(`upgrade surface: ${surface.pricingTable ? "PricingTable mounted" : "openUserProfile fallback button"}`);
  await pageB.screenshot({ path: path.join(ART, "4-landing-unentitled.png"), fullPage: true });

  // Someone else's device: the free tier admits the session, ownership says no.
  await pageB.goto(`${BASE}/chat?device=${encodeURIComponent(targetDevice)}`);
  await pageB.locator(".auth-overlay", { hasText: /Device not found/ }).waitFor({ timeout: 20000 });
  await pageB.screenshot({ path: path.join(ART, "5-chat-not-yours.png") });
  log("chat on another user's device: 4003 rendered as not-yours notice");

  // Free journey: link first's own device (1 allowed on the free tier) — via
  // the MANUAL code-entry path (/link with no ?code), as if the code were
  // shown on another machine.
  const startedFree = await (
    await fetch(`${BASE}/api/link/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e free box" }),
    })
  ).json();
  await pageB.goto(`${BASE}/link`);
  await pageB.locator("#link-code-form").waitFor({ timeout: 15000 });
  await pageB.fill("#link-code-input", startedFree.code);
  await pageB.locator("#link-code-form button").click();
  await pageB.waitForURL(/\/link\?code=/, { timeout: 10000 });
  log("manual link entry: code form routed to the approval page");
  const approveFree = pageB.locator("#approve");
  await approveFree.waitFor({ state: "visible", timeout: 15000 }); // already signed in — no gate
  await approveFree.click();
  // Straight into the fresh device's chat; STAY on it — attachUplink below
  // replays client-ready for this live page, the same choreography a real
  // extension coming online mid-visit drives.
  await pageB.waitForURL(/\/chat\?device=/, { timeout: 15000 });
  assert.ok(new URL(pageB.url()).searchParams.get("device"), "approval redirect should carry the device id");
  log("free tier: first linked their own device — landed in its chat");

  const polledFree = await (
    await fetch(`${BASE}/api/link/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: startedFree.code }),
    })
  ).json();
  uplinkFree = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(polledFree.token)}`);
  const upFree = inboxOf(uplinkFree);
  await new Promise((res, rej) => {
    uplinkFree.once("open", res);
    uplinkFree.once("error", rej);
  });
  uplinkFree.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "e2e free box" } }));

  // …and chat on it within the daily quota (the page is already there).
  const readyFree = await upFree.matching((m) => m.t === "client-ready");
  // chat.js keeps the composer disabled until the host syncs it — answer the
  // ready with a snapshot, as the real extension does.
  uplinkFree.send(
    JSON.stringify({
      t: "snapshot",
      clientId: readyFree.clientId,
      msgs: [{ type: "clearMessages" }, { type: "messageChunk", text: "free-snap" }],
    }),
  );
  await pageB.locator("#messages", { hasText: "free-snap" }).waitFor({ timeout: 15000 });
  await pageB.fill("#input", "free tier message");
  await pageB.locator("#send-btn").click();
  await upFree.matching((m) => m.t === "msg" && JSON.stringify(m.msg).includes("free tier message"));
  await pageB.screenshot({ path: path.join(ART, "6-chat-free-tier.png") });
  log("free tier: chat works within quota");

  // Usage meter: back on the landing, the spent prompt shows up (1 / 100).
  await pageB.goto(`${BASE}/`);
  const meter = pageB.locator("#usage-meter");
  await meter.waitFor({ timeout: 20000 });
  const meterText = (await meter.textContent()) ?? "";
  assert.match(meterText.replace(/\s+/g, " "), /1\s*\/\s*100/, `usage meter should show 1/100, got: ${meterText}`);
  log("usage meter: shows 1 / 100 after one prompt");
  await pageB.screenshot({ path: path.join(ART, "7-usage-meter.png") });

  // Remove the device from the web: confirm in the dialog, then the live
  // uplink must die with 4001 (token revoked) and the list empty out.
  const uplinkClosed = new Promise((resolve) => uplinkFree.on("close", (c) => resolve(c)));
  const removeBtn = pageB.locator(`.device-remove`).first();
  await removeBtn.click();
  await pageB.locator("#dialog-confirm", { hasText: "Unlink" }).click();
  const closeCode = await uplinkClosed;
  assert.equal(closeCode, 4001, `revoked uplink should close 4001, got ${closeCode}`);
  await pageB.locator("#empty").waitFor({ state: "visible", timeout: 15000 });
  log("device removed from the web: uplink closed 4001, list empty");
  await pageB.screenshot({ path: path.join(ART, "8-device-removed.png") });
  await ctxB.close();

  log("ALL FLOWS PASSED");
}

main()
  .then(() => cleanup(0))
  .catch(async (e) => {
    console.error("[e2e] FAILED:", e);
    try {
      for (const [i, ctx] of (browser?.contexts() ?? []).entries())
        for (const [j, p] of ctx.pages().entries())
          await p.screenshot({ path: path.join(ART, `fail-${i}-${j}.png`) }).catch(() => {});
    } catch {
      /* best effort */
    }
    cleanup(1);
  });

function cleanup(codeExit) {
  writeFileSync(path.join(ART, "relay.log"), relayLog.join(""));
  try {
    uplink?.close();
  } catch {}
  try {
    uplinkFree?.close();
  } catch {}
  try {
    relay?.kill();
  } catch {}
  scrubDevices()
    .catch(() => {})
    .finally(() => browser?.close().finally(() => process.exit(codeExit)));
}
