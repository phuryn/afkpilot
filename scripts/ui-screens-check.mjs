// Screens check — drives the REAL /chat page through a scripted session and
// asserts the things a DOM test cannot, then leaves screenshots behind for a
// person (or a model) to look at.
//
// WHY THIS EXISTS. The vitest DOM suites run in happy-dom, which has no layout
// engine: `getBoundingClientRect()` is zeros and stylesheets are never applied.
// So an icon with no width, a control pushed off-screen, or a panel overlapping
// the header all satisfy every assertion those suites can make. The file
// panel's action row shipped as three EMPTY BOXES — every icon sized 0×0 —
// through a green suite, three review rounds and a vendored deploy. The owner
// found it in a screenshot. This is the gate that would have caught it.
//
// What it asserts is deliberately narrow: rendered geometry, and nothing about
// behaviour. Behaviour has its own suites and they are better at it.
//
// Run: npm run e2e:screens   (screens land in .screens/, gitignored)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { chromium } from "playwright";

const PORT = Number(process.env.SCREENS_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.SCREENS_DIR || ".screens";
const CWD = "/work/grok-remote";
const log = (m) => console.log(`[screens] ${m}`);
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const README = [
  "# grok-remote",
  "",
  "Relay server and web client for driving the desk machine from a phone.",
  "",
  "## What this is",
  "",
  "- a relay (`src/server.ts`)",
  "- a web client (`web/`)",
  "- one file panel, shared with the desktop",
  "",
].join("\n");

// A CODE file, because README.md resolves to no language and so proves nothing
// about syntax highlighting. Without this the panel's whole highlighting path
// — the token spans in read mode and the transparent-textarea overlay in edit
// mode — never ran in a real browser at all, in a gate whose entire purpose is
// the things happy-dom structurally cannot see.
const PKG = [
  "{",
  '  "name": "grok-remote",',
  '  "private": true,',
  '  "scripts": { "start": "node dist/main.js" }',
  "}",
  "",
].join("\n");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const relay = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, RELAY_PORT: String(PORT), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "", SPRITES_TOKEN: "", SPRITES_LABELS: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
let relayStderr = "";
relay.stderr.on("data", (d) => { relayStderr += String(d); });

const postJson = async (p, body) =>
  (await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/**
 * Every icon that is on screen must actually occupy space.
 *
 * This is the assertion the blank-icon bug needed. An `<svg>` with only a
 * viewBox and no CSS size collapses; in happy-dom that is invisible, in a
 * browser it is an empty button.
 */
const BLANK_ICONS = `() => {
  const bad = [];
  for (const svg of document.querySelectorAll("button svg, .gfp-action svg, .icon-btn svg")) {
    const host = svg.closest("button, .gfp-action, .icon-btn");
    if (!host || host.hidden || host.offsetParent === null) continue;
    // A button may legitimately hold several icons and show one — the theme
    // toggle carries both a sun and a moon and hides the inactive one. Only an
    // icon that is meant to be painted has to have a size.
    if (getComputedStyle(svg).display === "none") continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) {
      bad.push((host.title || host.id || host.className || "?") + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
  }
  return bad;
}`;

/** Bar-icon primitive: every visible icon-only chrome member is 20×20 with
 *  an unpainted box. Pencil stays 16; the in-tab X stays 14 (15 on coarse). */
const BAR_ICONS = `() => {
  const isTransparent = (c) => {
    if (!c || c === "transparent") return true;
    const m = String(c).match(/^rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\)$/);
    return !!(m && m[1] === "0" && m[2] === "0" && m[3] === "0" && (m[4] === undefined || Number(m[4]) === 0));
  };
  const isVisible = (el) => {
    if (!el || el.hidden) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (el.offsetParent !== null || s.position === "fixed");
  };
  const paintedSvg = (el) => [...el.querySelectorAll("svg")].find((n) => getComputedStyle(n).display !== "none");
  const glyphW = (el) => {
    const svg = paintedSvg(el);
    return svg ? Math.round(svg.getBoundingClientRect().width) : 0;
  };
  const noPaintedBox = (el) => {
    const s = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"];
    const borderNone = sides.every((side) => s["border" + side + "Style"] === "none" || parseFloat(s["border" + side + "Width"]) === 0);
    return { borderNone, bgClear: isTransparent(s.backgroundColor), bg: s.backgroundColor, border: s.borderTopStyle };
  };
  const labelOf = (el) => el.id || el.getAttribute("aria-label") || el.title || String(el.className || "").trim().split(/\\s+/)[0] || "?";
  const SEL = [
    ".icon-btn:not(.session-name-edit):not(#session-head-edit)",
    ".rail-icon-btn",
    ".desk-rail-open-btn",
    ".gfp-toggle",
    ".gfp-icon-button",
    ".gfp-close",
    ".gfp-viewer .gfp-action.gfp-icon-only",
    "#session-head .rail-action-btn",
    "#session-head-actions .rail-action-btn",
    "#vscode-session-actions .rail-action-btn",
  ].join(",");
  const bad = [];
  const seen = [];
  const members = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.includes(el) || !isVisible(el)) continue;
    seen.push(el);
    const g = glyphW(el);
    const box = noPaintedBox(el);
    const what = labelOf(el);
    members.push({ what, glyph: g, bg: box.bg, border: box.border });
    if (Math.abs(g - 20) > 1) bad.push(what + " glyph " + g + "px (want 20)");
    if (!box.borderNone) bad.push(what + " border-style " + box.border);
    if (!box.bgClear) bad.push(what + " background " + box.bg);
  }
  const pencil = document.querySelector("#session-head-edit, button.session-name-edit");
  if (pencil && isVisible(pencil)) {
    const g = glyphW(pencil);
    const box = noPaintedBox(pencil);
    members.push({ what: "pencil", glyph: g, exempt: true });
    if (Math.abs(g - 16) > 1) bad.push("pencil glyph " + g + "px (want 16)");
    if (!box.borderNone) bad.push("pencil border-style " + box.border);
    if (!box.bgClear) bad.push("pencil background " + box.bg);
  }
  const tabX = document.querySelector(".gfp-tab-active:not([hidden]) .gfp-tab-close");
  if (tabX && isVisible(tabX)) {
    const g = glyphW(tabX);
    const coarse = matchMedia("(hover: none) and (pointer: coarse)").matches;
    const want = coarse ? 15 : 14;
    members.push({ what: "tab-X", glyph: g, exempt: true });
    if (Math.abs(g - want) > 1) bad.push("tab-X glyph " + g + "px (want " + want + ")");
  }
  return { bad, members };
}`;

async function assertNoBlankIcons(page, where) {
  // Invoked, not just evaluated: `page.evaluate("() => {…}")` returns the
  // function itself, which serialises to undefined and makes this assert fire
  // on every page whether or not anything is wrong.
  const blank = await page.evaluate(`(${BLANK_ICONS})()`);
  assert.deepEqual(blank, [], `${where}: icons rendered with no size — ${JSON.stringify(blank)}`);
}

async function assertBarIcons(page, where) {
  const { bad, members } = await page.evaluate(`(${BAR_ICONS})()`);
  assert.ok(members.length > 0, `${where}: bar-icon gate measured nothing`);
  assert.deepEqual(bad, [], `${where}: bar-icon primitive — ${JSON.stringify(bad)} (saw ${JSON.stringify(members)})`);
  const selected = await page.evaluate(() => {
    const group = document.querySelector(".gfp-viewer .gfp-seg");
    if (!group || group.offsetParent === null) return null;
    const gs = getComputedStyle(group);
    const on = group.querySelector(".gfp-seg-on");
    const os = on ? getComputedStyle(on) : null;
    return {
      groupBorder: gs.borderTopStyle,
      groupBorderW: gs.borderTopWidth,
      onTitle: on?.title || "",
      onBg: os?.backgroundColor || "",
      onCount: group.querySelectorAll(".gfp-seg-on").length,
    };
  });
  if (selected) {
    assert.ok(
      selected.groupBorder !== "none" && parseFloat(selected.groupBorderW) > 0,
      `${where}: .gfp-seg must paint a group border (style ${selected.groupBorder}, width ${selected.groupBorderW})`,
    );
    assert.equal(selected.onCount, 1, `${where}: segmented control must have exactly one .gfp-seg-on`);
    const clear = !selected.onBg || selected.onBg === "transparent" || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(selected.onBg);
    assert.ok(!clear, `${where}: selected "${selected.onTitle}" must have a filled background (${selected.onBg})`);
  }
}

async function assertToolbarEnd(page, where) {
  const info = await page.evaluate(() => {
    const bar = document.querySelector(".gfp-viewer-head");
    const end = document.querySelector(".gfp-viewer-end");
    if (!bar || !end || end.offsetParent === null) return null;
    const b = bar.getBoundingClientRect();
    const e = end.getBoundingClientRect();
    return { barRight: b.right, endRight: e.right, gap: Math.round(b.right - e.right) };
  });
  if (!info) return;
  assert.ok(
    info.gap >= -2 && info.gap <= 12,
    `${where}: toolbar end (Cancel/Save/⋯) must sit at the bar's right edge (gap ${info.gap}px) — ${JSON.stringify(info)}`,
  );
}

/**
 * Photograph the settings surface, Routines included.
 *
 * The rest of this file drives /chat. Settings is a whole second surface behind
 * the gear, and nothing was ever looking at it — which is how a button laid out
 * by the wrong grid and a control clipped below its own text both shipped
 * through a green gate.
 *
 * Screenshots are for a human (or a model) asked to check something visually.
 * The assertion below is the deterministic half: an action button that has
 * wrapped is never intentional, and that is exactly what "Run now" did.
 */
async function settingsScreens(page, name) {
  // Below the docking breakpoint the rail is collapsed and its gear is not
  // clickable until the rail is opened — the same route the rail shot takes.
  let openedRail = false;
  // Whatever this function opens, it closes. Leaving the rail up on the narrow
  // layouts parks its scrim over everything the REST of the run needs to click,
  // which turned a skipped screenshot into a failure three sections later.
  const closeRail = async () => {
    if (!openedRail) return;
    openedRail = false;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
    const scrim = page.locator("#rail-scrim");
    if (await scrim.isVisible().catch(() => false)) {
      await scrim.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  };

  let gear = page.locator("#rail-gear-btn, #gear-btn").first();
  if (!(await gear.isVisible().catch(() => false))) {
    const railOpen = page.locator("#rail-open");
    if (await railOpen.isVisible().catch(() => false)) {
      await railOpen.click();
      openedRail = true;
      await page.waitForTimeout(300);
    }
    gear = page.locator("#rail-gear-btn, #gear-btn").first();
  }
  if (!(await gear.isVisible().catch(() => false))) {
    log(`${name}: no reachable gear — skipping the settings screens`);
    await closeRail();
    return;
  }
  // On the narrow layouts the rail's scrim can still be over the gear while it
  // animates in. Skip rather than force: a forced click would photograph a
  // surface a real tap could not reach, which is worse than no photograph. If
  // this starts skipping every run, the scrim is genuinely covering the gear
  // and that is a bug to chase rather than a timing quirk to absorb.
  try {
    await gear.click({ timeout: 4000 });
  } catch {
    log(`${name}: gear not tappable (rail scrim) — skipping the settings screens`);
    await closeRail();
    return;
  }
  const entry = await page.$$eval("#gear-popover .toolbar-popover-item", (els) => {
    const hit = els.find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()));
    if (hit) hit.setAttribute("data-screens-settings", "1");
    return !!hit;
  });
  assert.ok(entry, `${name}: the gear must offer Settings`);
  await page.click('[data-screens-settings="1"]');
  await page.waitForSelector("#settings-overlay", { timeout: 10000 });
  await page.waitForTimeout(250);
  await shot(page, `${name}-11-settings`);

  for (const category of ["Routines", "Connectors"]) {
    await page.$$eval(
      "#settings-overlay .settings-nav-item",
      (els, want) => {
        const hit = els.find((el) => (el.textContent || "").trim() === want);
        if (hit) hit.setAttribute("data-screens-nav", "1");
      },
      category,
    );
    // Presence is not reachability: the narrow layouts keep the nav list in the
    // DOM but collapse the real control into a <select>, so the item is found
    // and never clickable. Try the item, fall back to the select, and only then
    // give up on this category.
    const reached = await page
      .click('[data-screens-nav="1"]', { timeout: 2500 })
      .then(() => true)
      .catch(() => page
        .locator("#settings-overlay .settings-nav-select")
        .selectOption({ label: category }, { timeout: 2500 })
        .then(() => true)
        .catch(() => false));
    if (!reached) {
      await page.$$eval("[data-screens-nav]", (els) => els.forEach((e) => e.removeAttribute("data-screens-nav")));
      continue;
    }
    await page.waitForTimeout(300);
    await shot(page, `${name}-12-settings-${category.toLowerCase()}`);
    await page.$$eval("[data-screens-nav]", (els) => els.forEach((e) => e.removeAttribute("data-screens-nav")));
  }

  // Open a routine so the form, the run log and the footer are all on screen.
  const routine = await page.$("#settings-overlay .settings-routine-toggle");
  if (routine) {
    await routine.click();
    await page.waitForTimeout(250);
    await shot(page, `${name}-13-settings-routine-open`);

    const wrapped = await page.$$eval("#settings-overlay .settings-routine-foot .settings-action", (els) =>
      els
        .map((el) => {
          // The CONTENT box, not the border box: padding makes a healthy
          // single-line button ~1.7 line-heights tall, which is close enough to
          // two to make a naive ratio useless. Subtracting the padding and
          // borders leaves a number that is 1 when the label fits on one line
          // and 2 when it does not.
          const cs = getComputedStyle(el);
          const chrome = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
            .reduce((sum, k) => sum + (parseFloat(cs[k]) || 0), 0);
          const line = parseFloat(cs.lineHeight) || 16;
          const content = el.getBoundingClientRect().height - chrome;
          return { label: (el.textContent || "").trim(), lines: Math.round((content / line) * 100) / 100 };
        })
        .filter((m) => m.lines > 1.5),
    );
    assert.deepEqual(wrapped, [], `${name}: a routine action button wrapped — ${JSON.stringify(wrapped)}`);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await closeRail();
}

/**
 * Empty-state advice on the BROWSER client, at whatever width this run uses.
 *
 * The desktop harness proves the same slot on the desk. What only this one can
 * show is the phone: 414px with a 2.625 DPR is where a 46ch measure either sits
 * inside the column or pushes the page sideways, and where a one-line tip
 * becomes six. It also pins the rule the owner asked for last — the pool a
 * remote sees must never include advice a remote cannot act on.
 */
async function welcomeTipScreens(page, name) {
  const tip = await page.evaluate(() => {
    const el = document.getElementById("welcome-tip");
    if (!el) return null;
    const body = el.querySelector(".welcome-tip-body");
    const close = el.querySelector(".welcome-tip-dismiss");
    const action = el.querySelector(".muted-link, b");
    const r = el.getBoundingClientRect();
    const clr = close ? close.getBoundingClientRect() : null;
    const ar = action ? action.getBoundingClientRect() : null;
    return {
      id: el.dataset.tip || "",
      text: (body?.textContent || "").replace(/\s+/g, " ").trim(),
      width: Math.round(r.width),
      height: Math.round(r.height),
      right: Math.round(r.right),
      overflows: el.scrollWidth > el.clientWidth + 1,
      close: clr ? { w: Math.round(clr.width), h: Math.round(clr.height) } : null,
      action: ar ? { w: Math.round(ar.width), h: Math.round(ar.height) } : null,
      bulb: (() => {
        const svg = el.querySelector(".welcome-tip-bulb svg");
        if (!svg) return null;
        const b = svg.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      })(),
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  });
  assert.ok(tip, `${name} chat: empty-state advice must render on a settled welcome screen`);
  assert.ok(tip.id, `${name} chat: the tip must carry its id`);
  // Desk-only advice must never reach a browser client. Signing an agent in,
  // linking a connector and starting a worktree are all host-local, and
  // "continue on your phone" is being read ON the phone.
  assert.ok(
    !["providers", "connectors", "remote", "worktrees", "moveView"].includes(tip.id),
    `${name} chat: desk-only advice reached a remote — ${JSON.stringify(tip)}`,
  );
  assert.ok(tip.text.length > 10, `${name} chat: tip text looks empty — ${JSON.stringify(tip)}`);
  assert.ok(tip.height > 10 && tip.width > 80, `${name} chat: tip has no box — ${JSON.stringify(tip)}`);
  assert.ok(!tip.overflows, `${name} chat: tip text overflows its box — ${JSON.stringify(tip)}`);
  assert.ok(
    tip.close && tip.close.w >= 6 && tip.close.h >= 6,
    `${name} chat: dismiss control rendered with no size — ${JSON.stringify(tip)}`,
  );
  assert.ok(
    tip.action && tip.action.w >= 20 && tip.action.h >= 6,
    `${name} chat: the actionable span rendered with no size — ${JSON.stringify(tip)}`,
  );
  // A 46ch box on a 414px phone is the case that would push the page sideways.
  assert.ok(
    tip.docScrollW <= tip.docClientW + 1,
    `${name} chat: the tip made the page scroll horizontally — ${JSON.stringify(tip)}`,
  );
  assert.ok(
    tip.bulb && tip.bulb.w >= 8 && tip.bulb.h >= 8,
    `${name} chat: the advice mark rendered with no size — ${JSON.stringify(tip)}`,
  );
  log(`${name} welcome tip: ${tip.id} — "${tip.text}" (${tip.width}x${tip.height}), mark ${tip.bulb.w}x${tip.bulb.h}`);
  await shot(page, `${name}-1b-welcome-tip`);

  // Taking it opens the settings category it names, and retires the line.
  await page.click("#welcome-tip .muted-link");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    open: !!document.getElementById("settings-overlay"),
    category: document.querySelector(".settings-nav-item.active")?.dataset.category || "",
    tip: document.getElementById("welcome-tip")?.dataset.tip || null,
  }));
  assert.ok(after.open, `${name} chat: taking a tip must open Settings — ${JSON.stringify(after)}`);
  assert.ok(after.category, `${name} chat: Settings opened on no category — ${JSON.stringify(after)}`);
  assert.notEqual(after.tip, tip.id, `${name} chat: acting on advice must retire that advice`);
  await shot(page, `${name}-1c-welcome-tip-target`);
  log(`${name} welcome tip target: settings on "${after.category}"`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // EVERY tip's action, not just the one that happened to be showing.
  //
  // This exists because the first version of this gate measured a single tip
  // and passed, and CI then failed on a DIFFERENT one — "Plan", reached only
  // because an earlier step had rotated the pool. A floor that depends on which
  // tip the rotation lands on is not a floor. So walk the whole pool by
  // dismissing, measure each action on the way past, and report all of them.
  const actions = await page.evaluate(() => {
    const seen = [];
    for (let i = 0; i < 14; i++) {
      const el = document.getElementById("welcome-tip");
      if (!el) break;
      const act = el.querySelector(".muted-link");
      if (act) {
        const b = act.getBoundingClientRect();
        seen.push({
          id: el.dataset.tip || "?",
          text: act.textContent.trim(),
          w: Math.round(b.width),
          h: Math.round(b.height),
        });
      }
      const close = el.querySelector(".welcome-tip-dismiss");
      if (!close) break;
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    return seen;
  });
  assert.ok(actions.length > 0, `${name}: the pool walk measured nothing`);
  // The floor is a TOUCH floor, and `desk` is a mouse — same split the panel
  // gate above uses. On a mouse an inline link is as big as its text and that
  // is correct; on a finger it is not.
  if (name !== "desk") {
    const tiny = actions.filter((a) => a.w < 36 || a.h < 36);
    assert.deepEqual(
      tiny, [],
      `${name}: tip actions under the 36px tap floor — ${JSON.stringify(tiny)} (saw ${JSON.stringify(actions)})`,
    );
  }
  log(`${name} tip actions: ${actions.map((a) => `${a.id} ${a.w}x${a.h}`).join(", ")}`);
}

/**
 * Add project on the BROWSER client.
 *
 * Two things only a real layout at these widths can say. First, that the modal
 * fits a 414px phone — it is 380px by design, and `min(380px, 100%)` either
 * holds or pushes the page sideways. Second, that the menu carries only what a
 * REMOTE can do: importing opens a native picker on the desk, which a phone has
 * no way to show, so it must not appear here at all.
 */
async function addProjectScreens(page, name) {
  // Coding mode, so the menu has two entries rather than collapsing to one.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "appPurpose", value: "coding" },
  })));
  await page.evaluate(() => {
    const card = document.getElementById("welcome-onboarding");
    card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project</button>';
    card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".rail-menu", { timeout: 8000 });
  const menu = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rail-menu-item")];
    const box = document.querySelector(".rail-menu").getBoundingClientRect();
    return {
      labels: rows.map((r) => r.querySelector(".rail-menu-label")?.textContent?.trim() || ""),
      clipped: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
      onScreen: box.left >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
      small: rows.filter((r) => r.getBoundingClientRect().height < 36).length,
    };
  });
  assert.deepEqual(
    menu.labels,
    ["Clone from GitHub", "New project"],
    `${name}: a remote must not be offered the native picker — ${JSON.stringify(menu)}`,
  );
  assert.ok(!menu.clipped, `${name}: add-project menu rows clipped — ${JSON.stringify(menu)}`);
  assert.ok(menu.onScreen, `${name}: add-project menu runs off screen — ${JSON.stringify(menu)}`);
  await shot(page, `${name}-1d-add-project-menu`);
  log(`${name} add project menu: ${menu.labels.join(" / ")}`);

  await page.click(".rail-menu-item");
  await page.waitForSelector(".add-project-form", { timeout: 8000 });
  await page.fill(".add-project-input", "https://github.com/phuryn/grok-remote.git");
  const form = await page.evaluate(() => {
    const el = document.querySelector(".add-project-form");
    const b = el.getBoundingClientRect();
    const controls = [...el.querySelectorAll("button, input")];
    return {
      dest: document.querySelector(".add-project-dest").textContent.trim(),
      width: Math.round(b.width),
      inside: b.left >= -1 && b.right <= window.innerWidth + 1,
      tall: b.height <= window.innerHeight,
      overflowsSelf: el.scrollWidth > el.clientWidth + 1,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      // Visible controls only: the fix button is hidden until a clone fails in
      // a way GitHub sign-in would mend, and a 0px hidden node is not a tap
      // target that is too small — it is not a tap target.
      small: controls
        .filter((c) => !c.hidden && c.offsetParent !== null)
        .filter((c) => c.getBoundingClientRect().height < 36)
        .map((c) => (c.className || c.tagName) + " " + Math.round(c.getBoundingClientRect().height)),
    };
  });
  assert.equal(form.dest, "~/Grok Build/grok-remote", `${name}: clone preview — ${JSON.stringify(form)}`);
  assert.ok(form.inside, `${name}: the form escapes the viewport — ${JSON.stringify(form)}`);
  assert.ok(form.tall, `${name}: the form is taller than the viewport — ${JSON.stringify(form)}`);
  assert.ok(!form.overflowsSelf, `${name}: the form scrolls sideways — ${JSON.stringify(form)}`);
  assert.ok(
    form.docScrollW <= form.docClientW + 1,
    `${name}: the form made the page scroll sideways — ${JSON.stringify(form)}`,
  );
  await shot(page, `${name}-1e-add-project-form`);
  log(`${name} add project form: ${form.dest} (${form.width}px)`);

  // Every control in a modal is a tap target on a phone. Same 36px floor the
  // rest of the app is held to, no exemptions.
  if (name !== "desk") {
    assert.deepEqual(form.small, [], `${name}: form controls too small to tap — ${JSON.stringify(form.small)}`);
    assert.equal(menu.small, 0, `${name}: menu rows too small to tap (${menu.small})`);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => !!document.querySelector(".add-project-form")),
    false,
    `${name}: Escape must close the form`,
  );
  // Put the client back where the rest of the run expects it.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "appPurpose", value: "knowledge" },
  })));
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  log(`captured ${name}.png`);
}

let browser, uplink;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  // A healthy /api/health is NOT proof it is OUR relay: a zombie from a killed
  // earlier run once held the port, answered health, and served a stale stub —
  // hours of runs quietly validated against the wrong fixture. If our child
  // died (EADDRINUSE lands in stderr), the run must die with it.
  if (relay.exitCode !== null) {
    throw new Error(`screens relay exited (code ${relay.exitCode}) — port ${PORT} taken by another process?\n${relayStderr.slice(0, 500)}`);
  }

  const started = await postJson("/api/link/start", { name: "screens box" });
  await postJson("/api/link/approve", { code: started.code });
  const token = (await postJson("/api/link/poll", { code: started.code })).token;

  uplink = new WebSocket(`${BASE.replace("http", "ws")}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise((res, rej) => { uplink.once("open", res); uplink.once("error", rej); });
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "Pawel-Desk" } }));

  const snapshot = (clientId, msgs) => uplink.send(JSON.stringify({ t: "snapshot", clientId, msgs }));
  const host = (clientId, msg) => uplink.send(JSON.stringify({ t: "host-to", clientIds: [clientId], msg }));
  let lastClientId = "";

  uplink.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === "client-ready") {
      lastClientId = f.clientId;
      snapshot(f.clientId, [
        { type: "clearMessages" },
        {
          type: "initialState", version: "screens", cwd: CWD, extVersion: "3.5.0",
          hostKind: "desktop", hostName: "Pawel-Desk",
          // `addProjectFolder` is deliberately absent: opening a native picker is
          // host-local, and a remote must not be offered a dialog it cannot see.
          // The other two take a name and a URL, so the host decides where.
          capabilities: {
            browseProjectFiles: true, editProjectFiles: true, uploadFile: true,
            createProject: true, cloneProject: true,
          },
        },
        {
          type: "repos",
          entries: [
            { cwd: CWD, label: "grok-remote", available: true, pinned: false, updatedAt: 3, archived: false, color: "" },
            { cwd: "/work/grok-build-vscode", label: "grok-build-vscode", available: true, pinned: false, updatedAt: 2, archived: false, color: "" },
          ],
          selectedCwd: CWD, activeCwd: CWD, workspaceCwd: CWD, canAddProject: false,
        },
        {
          type: "sessions",
          entries: [{ id: "s1", cwd: CWD, displayName: "One file panel, two hosts", rawSummary: "", updatedAt: 3, createdAt: 1, numMessages: 2 }],
          activeId: "s1", dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
        },
        { type: "sessionName", sessionId: "s1", name: "One file panel, two hosts" },
        // Empty-state advice needs three things a bare snapshot never had: who
        // is connected, the two counts a chat client cannot observe, and the
        // Starting -> Connected cycle it waits for. `initialized` MUST precede
        // setBusy:false — that pair is what stamps "Connected" and opens the
        // advice slot.
        { type: "providerState", providers: [{ id: "grok", connected: true }] },
        { type: "welcomeTips", routineCount: 0, connectorCount: 0, dismissed: [] },
        { type: "projectSetup", root: "~/Grok Build" },
        { type: "initialized", info: { provider: "grok", version: "1.0.5" } },
        { type: "setBusy", value: false },
      ]);
      return;
    }
    if (f.t !== "msg") return;
    const m = f.msg;
    if (m.type === "listProjectDir") {
      const rel = m.relPath || "";
      host(f.clientId, {
        type: "projectDirListing", requestId: m.requestId, cwd: m.cwd, relPath: rel, ok: true, truncated: false,
        entries: rel === ""
          ? [
              { name: "docs", kind: "dir", relPath: "docs" },
              { name: "src", kind: "dir", relPath: "src" },
              { name: "web", kind: "dir", relPath: "web" },
              { name: "README.md", kind: "file", relPath: "README.md" },
              { name: "package.json", kind: "file", relPath: "package.json" },
              // Enough previewable files to force the strip's overflow chip
              // (state C) at phone width — the chip e2e needs them.
              { name: "GUIDE.md", kind: "file", relPath: "GUIDE.md" },
              { name: "NOTES.md", kind: "file", relPath: "NOTES.md" },
              { name: "TODO.md", kind: "file", relPath: "TODO.md" },
              { name: "SETUP.md", kind: "file", relPath: "SETUP.md" },
              { name: ".env.example", kind: "file", relPath: ".env.example" },
              { name: "USAGE.md", kind: "file", relPath: "USAGE.md" },
              { name: "FAQ.md", kind: "file", relPath: "FAQ.md" },
            ]
          : [{ name: "server.ts", kind: "file", relPath: `${rel}/server.ts` }],
      });
      return;
    }
    if (m.type === "listRoutines") {
      // Enough shape to photograph every state the page can be in: a healthy
      // run strip, a failure, a skip, an archived project in the picker, and
      // models from two providers so the optgroups have something to group.
      host(f.clientId, {
        type: "routines",
        projects: [
          { cwd: CWD, label: "grok-remote", defaultProvider: "grok" },
          { cwd: `${CWD}-notes`, label: "notes", archived: true, defaultProvider: "claude" },
        ],
        models: [
          { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
          { provider: "grok", model: "grok-4.6-fast", label: "Grok 4.6 Fast" },
          { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
        ],
        entries: [{
          id: "r1", title: "Morning brief",
          prompt: "Summarise what changed in this repo since your last run.",
          cwd: CWD, provider: "grok", model: "grok-4.6",
          cadence: { every: 1, unit: "days", at: "09:00" },
          createdAt: 1, cadenceLabel: "Every day at 09:00",
          nextRunAt: Date.now() + 42 * 60_000,
          projectLabel: "grok-remote",
          runs: [
            { routineId: "r1", windowKey: "d3", startedAt: Date.now() - 6e5, outcome: "ran", sessionId: "s-3", cwd: CWD },
            { routineId: "r1", windowKey: "d2", startedAt: Date.now() - 9e7, outcome: "skipped", detail: "Skipped — Claude was not connected" },
            { routineId: "r1", windowKey: "d1", startedAt: Date.now() - 1.8e8, outcome: "failed", detail: "Failed — the agent could not start" },
          ],
          health: { ran: 1, skipped: 1, failed: 1, total: 3 },
        }],
      });
      return;
    }
    if (m.type === "readProjectFile") {
      const body = m.relPath === "README.md"
        ? { kind: "markdown", text: README }
        : m.relPath === "package.json"
          ? { kind: "json", text: PKG, pretty: true }
          : /^(GUIDE|NOTES|TODO|SETUP|USAGE|FAQ)\.md$/.test(m.relPath)
            ? { kind: "markdown", text: `# ${m.relPath}\n\nOverflow-chip fixture file.` }
            : null;
      host(f.clientId, body
        ? {
            type: "projectFileContent", requestId: m.requestId, cwd: m.cwd, relPath: m.relPath, ok: true,
            ...body, stamp: { mtimeMs: 1, size: body.text.length }, absPath: `${m.cwd}/${m.relPath}`,
          }
        : { type: "projectFileContent", requestId: m.requestId, cwd: m.cwd, relPath: m.relPath, ok: false, reason: "not previewable" });
    }
  });

  const deviceId = ((await (await fetch(`${BASE}/api/devices`)).json()).devices || [])[0]?.deviceId;
  assert.ok(deviceId, "the uplink must register a device");

  browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);

  for (const layout of [
    // Three shapes, chosen off the ONE breakpoint that matters: the browser
    // client gives the panel a third column to dock into at 900px and not
    // below. `desk` is comfortably above it, `phone` comfortably below, and
    // `tablet` sits just under it — the width that was broken, where the panel
    // used to float over the middle of the chat with the rail behind it because
    // it had stopped docking but had not started filling. A gate with only the
    // two extremes is exactly how that shipped.
    { name: "desk", viewport: { width: 1440, height: 900 }, docked: true },
    { name: "tablet", viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, docked: false },
    // deviceScaleFactor: a REAL phone DPR — integer scrollWidth rounding at
    // fractional DPRs is how "CLAUDE.md" ellipsized beside free space while
    // DPR-1 runs stayed green.
    { name: "phone", viewport: { width: 414, height: 896 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, docked: false },
  ]) {
    const { name, docked, ...contextOptions } = layout;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__screensTestSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__screensTestSockets.push(this);
        }
      };
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

    await page.goto(`${BASE}/chat?device=${encodeURIComponent(deviceId)}&linked=1`, { waitUntil: "load" });
    await page.waitForSelector("#input", { timeout: 30000 });
    await page.waitForSelector("#files-browse-btn", { timeout: 30000 });
    await page.waitForTimeout(400);
    await shot(page, `${name}-1-chat`);
    await welcomeTipScreens(page, name);
    await addProjectScreens(page, name);
    // Done here, on a freshly loaded page, rather than at the end: the later
    // sections deliberately leave the client mid-reconnect, and settings should
    // be photographed in its ordinary state.
    await settingsScreens(page, name);
    await assertNoBlankIcons(page, `${name} chat`);
    await assertBarIcons(page, `${name} chat`);
    // Captured while the central header is visible — the phone's full-screen
    // panel hides it later, and the parity check below needs its real height.
    // On remote mobile the central header is the #session-head row (the
    // .top-bar is a desk affordance and measures 0 here).
    const topBarH = await page.evaluate(() => {
      for (const sel of ["#session-head", ".top-bar"]) {
        const el = document.querySelector(sel);
        const h = el ? Math.round(el.getBoundingClientRect().height) : 0;
        if (h > 0) return h;
      }
      return 0;
    });

    // --- the panel, showing the tree ---------------------------------------
    await page.locator("#files-browse-btn").click();
    await page.waitForSelector(".gfp-panel:not([hidden])", { timeout: 15000 });
    await page.waitForSelector(".gfp-row", { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot(page, `${name}-2-tree`);
    await assertNoBlankIcons(page, `${name} tree`);
    await assertBarIcons(page, `${name} tree`);
    assert.equal(
      await page.evaluate(() => { const f = document.querySelector(".gfp-filter"); return !!f && getComputedStyle(f).display !== "none"; }),
      true,
      `${name}: the tree filter must be available while the tree is showing`,
    );

    // --- a file open -------------------------------------------------------
    await page.locator(".gfp-row", { hasText: "README.md" }).first().click();
    await page.waitForSelector(".gfp-viewer:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(400);
    await shot(page, `${name}-3-file`);
    await assertNoBlankIcons(page, `${name} file open`);
    await assertBarIcons(page, `${name} file open`);
    assert.equal(
      await page.evaluate(() => { const f = document.querySelector(".gfp-filter"); return !!f && getComputedStyle(f).display !== "none"; }),
      false,
      `${name}: the tree filter must hide once a file is open — it has no tree to search`,
    );
    assert.deepEqual(
      // Modes live in .gfp-seg now; titles still paint in this order because
      // Preview / Edit source stay first in the toolbar. Query by [title] so
      // text buttons (no title) drop out. The trailing ⋯ is no longer
      // host-local: copying a path needs no round-trip, so it is offered on
      // every client — remote included, which is the surface where retyping a
      // path hurts most and the one that used to have no row menu at all.
      await page.evaluate(() => [...document.querySelectorAll(".gfp-viewer-head [title]")].map((b) => b.title)),
      ["Preview", "Edit source", "More actions"],
      `${name}: Markdown shows the mode pair plus the copy menu`,
    );

    // The ⋯ exists FOR the copy items, so prove they are in it. Asserting the
    // button alone would pass just as happily on an empty menu, which is the
    // shape this would regress into if the host-capability gate crept back.
    await page.locator(".gfp-viewer-head [title='More actions']").click();
    await page.waitForSelector(".gfp-menu", { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll(".gfp-menu-item")].map((b) => b.textContent)),
      ["Copy relative path", "Copy path"],
      `${name}: the remote ⋯ carries both copy forms and nothing host-local`,
    );
    // Same anchor toggles it shut (beginMenu), leaving the toolbar as found.
    await page.locator(".gfp-viewer-head [title='More actions']").click();
    await page.waitForTimeout(150);
    await assertToolbarEnd(page, `${name} file open`);

    // --- editing -----------------------------------------------------------
    await page.locator(".gfp-viewer [title='Edit source']").click();
    await page.waitForSelector(".gfp-editor", { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot(page, `${name}-4-edit`);
    await assertNoBlankIcons(page, `${name} editing`);
    await assertBarIcons(page, `${name} editing`);
    await assertToolbarEnd(page, `${name} editing`);

    // --- syntax highlighting, in a real browser ----------------------------
    // Back to the tree (the first tab is the project), then open a file that
    // actually has a language. README.md deliberately has none, so every frame
    // above proves nothing about this.
    await page.locator(".gfp-title").first().click();
    await page.waitForSelector(".gfp-tree:not([hidden]) .gfp-row", { timeout: 15000 });
    await page.locator(".gfp-row", { hasText: "package.json" }).first().click();
    await page.waitForSelector(".gfp-viewer:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(400);
    await shot(page, `${name}-5-code`);
    const readTokens = await page.evaluate(() => {
      const pre = document.querySelector(".gfp-viewer-body pre");
      if (!pre) return null;
      const painted = [...pre.querySelectorAll("span[class^='hl-']")];
      return {
        count: painted.length,
        // A token with no colour of its own is a class that never got a rule —
        // the stylesheet and the tokenizer drifting apart, which is invisible
        // to any DOM-only test.
        coloured: painted.filter((el) => {
          const c = getComputedStyle(el).color;
          return c && c !== "rgba(0, 0, 0, 0)";
        }).length,
        distinct: new Set(painted.map((el) => getComputedStyle(el).color)).size,
        text: pre.textContent,
      };
    });
    assert.ok(readTokens, `${name}: no <pre> to highlight`);
    assert.ok(readTokens.count > 0, `${name}: JSON rendered with no tokens at all`);
    assert.equal(readTokens.coloured, readTokens.count, `${name}: some tokens painted with no colour`);
    assert.ok(readTokens.distinct > 1, `${name}: every token is the same colour — the palette did not load`);
    // Highlighting is decoration: the text must survive it exactly.
    assert.ok(
      readTokens.text.includes('"name": "grok-remote"'),
      `${name}: highlighting altered the file's text — ${JSON.stringify(readTokens.text)}`,
    );

    await page.locator(".gfp-viewer .gfp-edit").first().click();
    await page.waitForSelector(".gfp-editor", { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot(page, `${name}-6-code-edit`);
    const overlay = await page.evaluate(() => {
      const editor = document.querySelector(".gfp-editor");
      const under = document.querySelector(".gfp-code-underlay");
      if (!editor || !under) return null;
      const e = getComputedStyle(editor);
      const u = getComputedStyle(under);
      const eb = editor.getBoundingClientRect();
      const ub = under.getBoundingClientRect();
      return {
        tokens: under.querySelectorAll("span[class^='hl-']").length,
        // The metrics that decide whether the caret sits on its glyph. Read
        // from the browser, which is the only thing that knows them.
        metrics: ["fontFamily", "fontSize", "lineHeight", "paddingLeft", "paddingTop", "whiteSpace", "letterSpacing"]
          .filter((k) => e[k] !== u[k]),
        // The two layers must start at the same point, or every line is offset.
        originDx: Math.round(Math.abs(eb.left - ub.left)),
        originDy: Math.round(Math.abs(eb.top - ub.top)),
        transparentText: e.color === "rgba(0, 0, 0, 0)",
      };
    });
    assert.ok(overlay, `${name}: edit mode built no highlight overlay for a known language`);
    assert.ok(overlay.tokens > 0, `${name}: the overlay painted no tokens`);
    assert.deepEqual(
      overlay.metrics,
      [],
      `${name}: the editor and its underlay disagree on ${overlay.metrics.join(", ")} — the caret will drift from the text`,
    );
    assert.ok(
      overlay.originDx === 0 && overlay.originDy === 0,
      `${name}: the overlay layers are offset by ${overlay.originDx}x${overlay.originDy}px`,
    );
    assert.ok(overlay.transparentText, `${name}: the textarea must not paint its own text over the highlighted copy`);
    await assertNoBlankIcons(page, `${name} code editing`);
    await assertBarIcons(page, `${name} code editing`);

    // --- geometry that only a browser knows --------------------------------
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".gfp-panel");
      const bar = document.querySelector("#files-browse-btn")?.closest("header, .top-bar, #session-head");
      const r = panel?.getBoundingClientRect();
      return {
        docked: !!document.querySelector(".gfp-panel.gfp-docked"),
        panelTop: r ? Math.round(r.top) : null,
        panelRight: r ? Math.round(r.right) : null,
        barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        panelBottom: r ? Math.round(r.bottom) : null,
        docWidth: document.documentElement.scrollWidth,
        // The way OUT of a full-screen panel has to be inside it.
        closeVisible: (() => {
          const close = document.querySelector(".gfp-panel .gfp-close");
          if (!close) return false;
          const b = close.getBoundingClientRect();
          return getComputedStyle(close).display !== "none" && b.width > 0 && b.height > 0;
        })(),
        tabCloseVisible: [...document.querySelectorAll(".gfp-panel .gfp-tab-close")]
          .some((el) => getComputedStyle(el).display !== "none"),
      };
    });
    assert.equal(geometry.docked, docked, `${name}: expected docked=${docked}`);
    assert.ok(
      geometry.panelRight <= geometry.viewportWidth + 1,
      `${name}: the panel must not run off the right edge (${geometry.panelRight} > ${geometry.viewportWidth})`,
    );
    assert.ok(
      geometry.docWidth <= geometry.viewportWidth + 1,
      `${name}: the page must not scroll horizontally (${geometry.docWidth} > ${geometry.viewportWidth})`,
    );
    if (docked) {
      // Desktop shape: the panel starts below the bar carrying its toggle.
      assert.ok(
        geometry.panelTop >= geometry.barBottom - 1,
        `${name}: the panel must start below the bar holding its toggle (panel ${geometry.panelTop}, bar bottom ${geometry.barBottom})`,
      );
      assert.ok(
        geometry.tabCloseVisible,
        `${name}: the desktop keeps per-tab close buttons`,
      );
    } else {
      // Phone shape: the panel IS the screen. A file browser squeezed under a
      // session header is the desktop layout wearing a phone's width.
      assert.equal(
        geometry.panelTop, 0,
        `${name}: the panel must cover the host chrome, not sit under it (top ${geometry.panelTop})`,
      );
      assert.ok(
        geometry.panelBottom >= geometry.viewportHeight - 1,
        `${name}: the panel must reach the bottom of the screen (${geometry.panelBottom} of ${geometry.viewportHeight})`,
      );
      // Covering the bar covers the button that opened the panel, so the way
      // out has to be inside it. This is the assertion that makes the rule
      // above safe rather than a trap.
      assert.ok(
        geometry.closeVisible,
        `${name}: a full-screen panel with no visible close button strands the user`,
      );
      // The ACTIVE tab keeps its X on the phone too (owner invariant: the X
      // is always visible for the active file; only one tab carries one now,
      // so the old crowding rationale is gone). The header ✕ still closes
      // the PANEL — two controls, two different jobs.
      assert.ok(
        geometry.tabCloseVisible,
        `${name}: the active tab must keep its close button on touch`,
      );
    }

    if (!docked) {
      // Touch targets. happy-dom cannot see this at all, and it is the class of
      // defect that only shows up on the device: a control that is present,
      // correct and three millimetres wide. 40px is below Apple's 44 and
      // Google's 48 on purpose — this is a floor that catches genuinely
      // unusable controls, not a design review.
      const small = await page.evaluate(() => {
        const SEL = "button, [role='button'], a[href], input, .gfp-row, .gfp-tab";
        return [...document.querySelectorAll(SEL)]
          .filter((el) => {
            // No exemptions. The in-row rail actions carried a 32px carve-out
            // for one day; the 2026-08-15 touch pass grew their click boxes to
            // the universal 36 (hit-slop over a 28px footprint, so rows stay
            // 36px), and the floor is one sentence again.
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden" || !el.offsetParent) return false;
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && (b.width < 36 || b.height < 36);
          })
          .map((el) => {
            const b = el.getBoundingClientRect();
            const label = el.getAttribute("aria-label") || el.title ||
              (el.textContent || "").trim().slice(0, 24) || el.className;
            // The SELECTOR too, not just the label — a failure you cannot act
            // on without going and finding the element yourself is half a
            // report. id when there is one, else the tag + its classes.
            const where = el.id
              ? `#${el.id}`
              : `${el.tagName.toLowerCase()}.${String(el.className || "").trim().split(/\s+/).join(".")}`;
            return `${label} (${Math.round(b.width)}x${Math.round(b.height)}) ${where}`;
          })
          .slice(0, 12);
      });
      // Was a ratchet with twelve named exceptions while the UI had them.
      // They are fixed, so this is now the plain assertion it always wanted to
      // be: nothing you tap with a finger is under 36px. Do not reintroduce a
      // baseline list — if something lands under the floor, raise the control.
      assert.deepEqual(
        small, [],
        `${name}: controls too small to tap — ${JSON.stringify(small, null, 2)}`,
      );

      // End-to-end: the X actually CLOSES the file on touch — tap it, watch
      // the tab go, then restore the state the rest of the flow expects.
      const tabsBefore = await page.evaluate(() => document.querySelectorAll(".gfp-tab:not([hidden])").length);
      await page.locator(".gfp-tab-active .gfp-tab-close").click();
      await page.waitForTimeout(300);
      const afterClose = await page.evaluate(() => ({
        tabs: document.querySelectorAll(".gfp-tab:not([hidden])").length,
        stillHasPackage: [...document.querySelectorAll(".gfp-tab")].some((t) => (t.title || "").includes("package.json")),
      }));
      assert.ok(
        afterClose.tabs < tabsBefore,
        `${name}: tapping the active tab's X must close the file (${tabsBefore} -> ${afterClose.tabs})`,
      );
      assert.ok(!afterClose.stillHasPackage, `${name}: package.json should be closed after tapping its X`);
      await page.locator(".gfp-title").click();
      await page.waitForSelector(".gfp-tree:not([hidden]) .gfp-row", { timeout: 15000 });

      // Touch density in the tree (owner, 2026-08-15): rows are the primary
      // tap targets, so they ride the same 36px floor as everything else (the
      // rail's row variable feeds .gfp-row), and the panel chrome rides the
      // 15px touch type scale. The code viewer deliberately does NOT — columns
      // beat point size for source — so the panel font is measured on the
      // container, not the viewer.
      const treeDensity = await page.evaluate(() => {
        const row = document.querySelector(".gfp-tree:not([hidden]) .gfp-row");
        const panel = document.querySelector(".gfp-panel");
        return {
          rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
          panelFont: panel ? parseFloat(getComputedStyle(panel).fontSize) : 0,
        };
      });
      assert.ok(
        treeDensity.rowH >= 35,
        `${name}: tree rows are tap targets — ~36px on touch (got ${treeDensity.rowH})`,
      );
      assert.equal(treeDensity.panelFont, 15, `${name}: panel chrome is 15px on touch (got ${treeDensity.panelFont})`);

      await page.locator(".gfp-row", { hasText: "package.json" }).first().click();
      await page.waitForTimeout(300);

      // The three mobile headers must share one scale (owner: the file panel
      // and the rail felt more cramped than the central top bar). Compare the
      // top bar's box against the panel strip; the rail's own top row is
      // checked when the rail opens later in this flow.
      // One bar scale (owner audit): every header-slot button glyph rides
      // 20px (the rename pencil is an inline text adornment, exempt), and the
      // panel's close pins to the strip's right edge.
      const barIcons = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("#session-head button svg, .top-bar button svg")) {
          const host = el.closest("button");
          if (!host || host.id === "session-head-edit" || host.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0) out.push({ what: host.id || host.getAttribute("aria-label") || host.className.split(" ")[0], w: Math.round(r.width) });
        }
        return out;
      });
      for (const icon of barIcons) {
        assert.ok(
          Math.abs(icon.w - 20) <= 1,
          `${name}: header icon "${icon.what}" is ${icon.w}px — the bar scale is 20px (owner audit)`,
        );
      }
      const closePin = await page.evaluate(() => {
        const x = document.querySelector(".gfp-close");
        const strip = document.querySelector(".gfp-header");
        if (!x || !strip || x.offsetParent === null) return null;
        return Math.round(strip.getBoundingClientRect().right - x.getBoundingClientRect().right);
      });
      if (closePin !== null) {
        assert.ok(closePin <= 16, `${name}: the panel close must pin to the strip's right edge (gap ${closePin}px)`);
      }
      const stripH = await page.evaluate(() => {
        const el = document.querySelector(".gfp-header");
        return el ? Math.round(el.getBoundingClientRect().height) : 0;
      });
      assert.ok(topBarH > 0 && stripH > 0, `${name}: both headers must exist (bar ${topBarH}, strip ${stripH})`);
      assert.ok(
        Math.abs(topBarH - stripH) <= 2,
        `${name}: the panel strip must match the top bar's height (${stripH} vs ${topBarH})`,
      );

      // A DOTFILE's whole name at phone width — the owner's screenshot showed
      // ".env" ellipsized to ".e…" beside an empty strip. With few tabs and
      // room to spare, the active name must render complete.
      if (name === "phone") {
        await page.locator(".gfp-title").click();
        await page.waitForSelector(".gfp-tree:not([hidden]) .gfp-row", { timeout: 15000 });
        await page.locator(".gfp-row", { hasText: ".env.example" }).first().click();
        await page.waitForTimeout(400);
        const dotname = await page.evaluate(() => {
          const el = document.querySelector(".gfp-tab-active .gfp-tab-name");
          return el
            ? { text: el.textContent, w: el.clientWidth, need: el.scrollWidth }
            : null;
        });
        assert.ok(dotname, `${name}: .env.example must open as the active tab`);
        assert.equal(dotname.text, ".env.example", `${name}: active tab must carry the dotfile name`);
        assert.ok(
          dotname.w >= dotname.need - 1,
          `${name}: ".env.example" ellipsized with free strip space (${dotname.w} < ${dotname.need})`,
        );
        // Close it so the chip walk below starts from the expected two tabs.
        await page.locator(".gfp-tab-active .gfp-tab-close").click();
        await page.waitForTimeout(300);
      }

      // The "…" chip on TOUCH, end to end. Open enough files to overflow the
      // strip, tap the chip, and HIT-TEST the menu — presence is not proof:
      // at z-index 1000 the dropdown mounted UNDER the full-screen panel
      // (1200) and tapping "…" presented nothing (owner-caught, 2026-08-15).
      if (name === "phone") {
      for (const fname of ["GUIDE.md", "NOTES.md", "TODO.md", "SETUP.md", "USAGE.md", "FAQ.md"]) {
        await page.locator(".gfp-title").click();
        await page.waitForSelector(".gfp-tree:not([hidden]) .gfp-row", { timeout: 15000 });
        await page.locator(".gfp-row", { hasText: fname }).first().click();
        await page.waitForTimeout(250);
      }
      await page.waitForSelector(".gfp-overflow-chip", { timeout: 5000 });
      await page.locator(".gfp-overflow-chip").click();
      await page.waitForSelector(".gfp-overflow-menu", { timeout: 5000 });
      const chipMenu = await page.evaluate(() => {
        const menu = document.querySelector(".gfp-overflow-menu");
        if (!menu) return { open: false };
        const rows = [...menu.querySelectorAll(".gfp-overflow-item")];
        const first = rows[0]?.getBoundingClientRect();
        const hit = first
          ? document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2)
          : null;
        return {
          open: true,
          rows: rows.map((r) => (r.querySelector(".gfp-overflow-name")?.textContent || "").trim()),
          firstRowHitTestLandsInMenu: !!(hit && menu.contains(hit)),
        };
      });
      assert.equal(chipMenu.open, true, `${name}: tapping … must open the overflow menu`);
      assert.ok(chipMenu.rows.length >= 1, `${name}: the overflow menu must list hidden files — ${JSON.stringify(chipMenu)}`);
      assert.ok(
        chipMenu.firstRowHitTestLandsInMenu,
        `${name}: the overflow menu must be ON TOP — hit-testing its first row missed (buried under the panel?) — ${JSON.stringify(chipMenu)}`,
      );
      await shot(page, `${name}-9-chip-menu`);
      await page.locator(".gfp-overflow-chip").click();
      await page.waitForFunction(() => !document.querySelector(".gfp-overflow-menu"), { timeout: 5000 });
      await page.locator(".gfp-overflow-chip").click();
      await page.waitForSelector(".gfp-overflow-menu", { timeout: 5000 });
      const target = chipMenu.rows[0];
      await page.locator(".gfp-overflow-item", { hasText: target }).first().click();
      await page.waitForTimeout(300);
      const activated = await page.evaluate(() =>
        document.querySelector(".gfp-tab-active .gfp-tab-name")?.textContent || "");
      assert.equal(activated, target, `${name}: tapping a menu row must activate that file (got "${activated}")`);
      }
    }

    // --- both panels, opened and closed ------------------------------------
    // The panel and the rail are the two things that take space from the chat,
    // and every layout complaint so far has been about how they share it. This
    // drives the real controls rather than asserting a stylesheet.
    const boxes = () => page.evaluate(() => {
      const vis = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || el.hasAttribute("hidden")) return null;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0
          ? { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), width: Math.round(b.width) }
          : null;
      };
      return {
        panel: vis(document.querySelector(".gfp-panel")),
        rail: vis(document.querySelector("#projects-rail")),
        composer: vis(document.querySelector("#input")),
        viewport: window.innerWidth,
      };
    });

    // Close the panel with its own control, whichever one this layout shows.
    const closer = docked ? "#files-browse-btn" : ".gfp-panel .gfp-close";
    await page.locator(closer).first().click();
    await page.waitForTimeout(350);
    const closed = await boxes();
    assert.equal(closed.panel, null, `${name}: the panel must close from its own control`);
    assert.ok(closed.composer, `${name}: closing the panel must give the composer back`);
    await shot(page, `${name}-7-panel-closed`);

    // Reopen it, so the toggle is proven to work both ways.
    await page.locator("#files-browse-btn").first().click();
    await page.waitForSelector(".gfp-panel:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(350);
    assert.ok((await boxes()).panel, `${name}: the panel must reopen from the toggle`);

    // Now the rail. On a wide screen it shares the row with the panel; on a
    // narrow one it CANNOT, because the panel owns the screen — so the two are
    // exercised differently on purpose. (Asserting the wide behaviour on a
    // phone is how this check first failed: it tried to click the rail's button
    // through the panel covering it.)
    if (docked) {
      const railOpen = page.locator("#rail-open");
      if (await railOpen.isVisible().catch(() => false)) await railOpen.click();
      await page.waitForTimeout(400);
      await shot(page, `${name}-8-both-open`);
      await assertBarIcons(page, `${name} rail+panel`);
      const both = await boxes();
      // Three columns, side by side, in order, none overlapping.
      assert.ok(both.rail && both.panel, `${name}: rail and panel must coexist on a wide screen`);
      assert.ok(
        both.rail.right <= both.panel.left + 1,
        `${name}: the rail and the panel must not overlap (rail ends ${both.rail.right}, panel starts ${both.panel.left})`,
      );
      assert.ok(both.composer, `${name}: the composer must survive both panels being open`);
    } else {
      // The panel owns the screen: full width, from the left edge. Anything
      // else is the in-between state that made tablet width look broken.
      const open = await boxes();
      assert.equal(
        open.panel && open.panel.left, 0,
        `${name}: the panel must span the screen, not float over the chat (left ${open.panel && open.panel.left})`,
      );
      assert.equal(
        open.panel.width, open.viewport,
        `${name}: the panel must be full width (${open.panel.width} of ${open.viewport})`,
      );
      // …and the rail is reachable once the panel is out of the way, which is
      // the whole contract: one surface at a time, and always a way back.
      await page.locator(".gfp-panel .gfp-close").first().click();
      await page.waitForTimeout(350);
      const railOpen = page.locator("#rail-open");
      assert.ok(
        await railOpen.isVisible().catch(() => false),
        `${name}: closing the panel must reveal the rail's own control`,
      );
      await railOpen.click();
      await page.waitForTimeout(400);
      await shot(page, `${name}-8-rail`);
      await assertBarIcons(page, `${name} rail`);
      const railed = await boxes();
      assert.ok(railed.rail, `${name}: the rail must open once the panel is closed`);
      // The rail's top row rides the same scale as the central header (owner:
      // the overlays felt more packed than the chat's own top row).
      const railTopH = await page.evaluate(() => {
        const el = document.querySelector(".rail-search-wrap");
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return Math.round(r.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom));
      });
      assert.ok(
        Math.abs(railTopH - topBarH) <= 6,
        `${name}: the rail's top row must share the central header's scale (${railTopH} vs ${topBarH})`,
      );
      // The close-rail toggle rides the same 20px bar scale as the open-rail
      // button (owner audit: it rendered 16px beside a 20px opener).
      const railToggleGlyph = await page.evaluate(() => {
        const svg = document.querySelector("#rail-toggle svg");
        return svg ? Math.round(svg.getBoundingClientRect().width) : 0;
      });
      assert.ok(
        Math.abs(railToggleGlyph - 20) <= 1,
        `${name}: #rail-toggle glyph is ${railToggleGlyph}px — the bar scale is 20px`,
      );
      // Touch density + type scale in the rail (owner, 2026-08-15): session
      // rows 36px / 15px text, project headers 40px / 16px text (the header
      // is itself a tap target and sat UNDER the floor at 34), inputs ≥16px
      // because iOS force-zooms the page on focusing anything smaller. The
      // numbers ARE the design, so they are asserted, not eyeballed.
      const density = await page.evaluate(() => {
        const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) : 0);
        const row = document.querySelector(".rail-session");
        const head = document.querySelector(".rail-repo-head");
        return {
          rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
          headH: head ? Math.round(head.getBoundingClientRect().height) : 0,
          nameFont: px(document.querySelector(".rail-session-name"), "fontSize"),
          repoFont: px(document.querySelector(".rail-repo-label"), "fontSize"),
          searchFont: px(document.querySelector("#rail-search, .rail-search"), "fontSize"),
        };
      });
      assert.ok(
        density.rowH >= 35 && density.rowH <= 40,
        `${name}: touch rail session rows should be ~36px (got ${density.rowH})`,
      );
      assert.ok(
        density.headH >= 39,
        `${name}: the project header is a tap target — 40px on touch (got ${density.headH})`,
      );
      assert.equal(density.nameFont, 15, `${name}: rail row text is 15px on touch (got ${density.nameFont})`);
      assert.equal(density.repoFont, 16, `${name}: project header text is 16px on touch (got ${density.repoFont})`);
      assert.ok(
        density.searchFont >= 16,
        `${name}: inputs under 16px make iOS zoom on focus (search is ${density.searchFont}px)`,
      );
    }

    // A painted conversation must reconnect without the full-screen veil.
    // happy-dom cannot see whether the overlay covers and blurs the
    // transcript; this is the layout check for that presentation choice.
    // Close the phone/tablet drawer first so the screenshot is the chat,
    // not the rail covering it. Playwright's scrim click is intercepted by
    // the rail itself; the toggle is the control that hides it.
    if (!docked) {
      const toggle = page.locator("#rail-toggle");
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }
    assert.ok(lastClientId, `${name}: need a live client to paint a message`);
    host(lastClientId, { type: "userMessage", text: "still reading this" });
    await page.locator(".msg.user", { hasText: "still reading this" }).waitFor({ timeout: 5000 });
    // Fill the column so the last line sits in the resting gap the indicator
    // occupies. A short transcript parks that line at the top and the overlap
    // check would pass even if the indicator covered a pinned last line.
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n\n");
    host(lastClientId, { type: "messageChunk", text: `${filler}\n\nthe last line a reader is looking at` });
    await page.locator(".msg", { hasText: "the last line a reader is looking at" }).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => {
      const lastBody = [...document.querySelectorAll("#messages .msg .body")].at(-1);
      const composer = document.querySelector(".composer");
      if (!lastBody || !composer) return false;
      const range = document.createRange();
      range.selectNodeContents(lastBody);
      return range.getBoundingClientRect().bottom > composer.getBoundingClientRect().top - 80;
    }, { timeout: 5000 });
    await page.evaluate(() => {
      const socket = [...(window.__screensTestSockets || [])].reverse()
        .find((s) => String(s.url).includes("/client?"));
      if (!socket) throw new Error("screens test could not find the browser client WebSocket");
      socket.close();
    });
    await page.waitForFunction(() => {
      const el = document.getElementById("reconnecting-indicator");
      return !!(el && !el.hidden);
    }, { timeout: 5000 });
    const reconnect = await page.evaluate(() => {
      const indicator = document.getElementById("reconnecting-indicator");
      const messages = document.getElementById("messages");
      const composer = document.querySelector(".composer");
      const overlay = document.querySelector(".auth-overlay.reconnecting");
      const overlayCs = overlay && !overlay.hidden ? getComputedStyle(overlay) : null;
      const msg = [...document.querySelectorAll(".msg")].find((el) =>
        /still reading this/.test(el.textContent || ""));
      const lastBody = [...document.querySelectorAll("#messages .msg .body")].at(-1);
      const i = indicator ? indicator.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      const msgCs = msg ? getComputedStyle(msg) : null;
      const shownH = messages ? messages.getBoundingClientRect().height : 0;
      if (indicator) indicator.hidden = true;
      const hiddenH = messages ? messages.getBoundingClientRect().height : 0;
      if (indicator) indicator.hidden = false;
      const shownHAfter = messages ? messages.getBoundingClientRect().height : 0;
      const overlap = (a, b) => {
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return dx > 0.5 && dy > 0.5;
      };
      let lastLine = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      if (lastBody) {
        const range = document.createRange();
        range.selectNodeContents(lastBody);
        lastLine = range.getBoundingClientRect();
      }
      const hitX = i.left + Math.min(24, Math.max(1, i.width / 2));
      const hitY = i.top + i.height / 2;
      const hit = i.height > 0 ? document.elementFromPoint(hitX, hitY) : null;
      const composerTop = composer ? composer.getBoundingClientRect().top : 0;
      const indCs = indicator ? getComputedStyle(indicator) : null;
      const msgPad = messages ? getComputedStyle(messages).paddingLeft : "";
      const indPad = indCs ? indCs.paddingLeft : "";
      return {
        overlayUp: !!(overlay && overlayCs && overlayCs.display !== "none"),
        indicatorHidden: !indicator || indicator.hidden,
        indicatorText: (indicator && !indicator.hidden ? indicator.textContent : "") || "",
        indicatorH: Math.round(i.height),
        indicatorW: Math.round(i.width),
        indicatorFullBleed: i.width >= window.innerWidth - 2 && i.height >= window.innerHeight - 2,
        msgVisible: !!(msg && msgCs && msgCs.visibility !== "hidden" && msgCs.display !== "none"),
        msgFilter: msgCs ? msgCs.filter : "",
        messagesHShown: shownH,
        messagesHHidden: hiddenH,
        messagesHReshown: shownHAfter,
        lastLineCovered: lastBody ? overlap(i, lastLine) : true,
        lastLineNearComposer: lastLine.bottom > composerTop - 80,
        pointerEvents: indCs ? indCs.pointerEvents : "",
        role: indicator ? indicator.getAttribute("role") : "",
        ariaLive: indicator ? indicator.getAttribute("aria-live") : "",
        hitIndicator: !!(hit && (hit.id === "reconnecting-indicator" || hit.closest("#reconnecting-indicator"))),
        composerGap: Math.round(composerTop - i.bottom),
        padLockstep: msgPad === indPad,
      };
    });
    assert.equal(reconnect.overlayUp, false, `${name}: a painted conversation must not take the reconnect veil — ${JSON.stringify(reconnect)}`);
    assert.equal(reconnect.indicatorHidden, false, `${name}: reconnecting must show the small indicator — ${JSON.stringify(reconnect)}`);
    assert.match(reconnect.indicatorText, /Reconnecting/);
    assert.ok(
      reconnect.indicatorH > 0 && reconnect.indicatorH < 48,
      `${name}: indicator should be a small status line (${reconnect.indicatorH}px)`,
    );
    assert.equal(reconnect.indicatorFullBleed, false, `${name}: indicator must not cover the viewport`);
    assert.equal(reconnect.msgVisible, true, `${name}: the conversation must stay painted`);
    assert.ok(
      !reconnect.msgFilter || reconnect.msgFilter === "none",
      `${name}: the transcript must not be blurred (${reconnect.msgFilter})`,
    );
    assert.equal(
      reconnect.messagesHShown, reconnect.messagesHHidden,
      `${name}: #messages height must not change when the indicator hides — ${JSON.stringify(reconnect)}`,
    );
    assert.equal(
      reconnect.messagesHHidden, reconnect.messagesHReshown,
      `${name}: #messages height must not change when the indicator shows — ${JSON.stringify(reconnect)}`,
    );
    assert.equal(
      reconnect.lastLineNearComposer, true,
      `${name}: last line must sit at the composer so covering is testable — ${JSON.stringify(reconnect)}`,
    );
    assert.equal(reconnect.lastLineCovered, false, `${name}: indicator must not cover the last transcript line — ${JSON.stringify(reconnect)}`);
    assert.equal(reconnect.pointerEvents, "none", `${name}: indicator must not eat taps — ${JSON.stringify(reconnect)}`);
    assert.equal(reconnect.hitIndicator, false, `${name}: a point on the indicator must fall through — ${JSON.stringify(reconnect)}`);
    assert.equal(reconnect.role, "status", `${name}: indicator must keep role=status`);
    assert.equal(reconnect.ariaLive, "polite", `${name}: indicator must keep aria-live`);
    assert.ok(
      Math.abs(reconnect.composerGap) <= 2,
      `${name}: indicator must sit on the composer, not in its own row (gap ${reconnect.composerGap}px)`,
    );
    assert.equal(reconnect.padLockstep, true, `${name}: rail measure padding-inline must match #messages — ${JSON.stringify(reconnect)}`);
    await shot(page, `${name}-10-reconnecting`);

    assert.deepEqual(errors, [], `${name}: the page logged errors — ${JSON.stringify(errors)}`);
    log(`${name}: ${docked ? "panel below its bar" : "panel full-screen with a way out"}, no blank icons, nothing off-screen`);
    await context.close();
  }

  log(`ALL CHECKS PASSED — screens in ${OUT}/`);
} finally {
  try { uplink?.close(); } catch { /* */ }
  try { await browser?.close(); } catch { /* */ }
  relay.kill();
}
