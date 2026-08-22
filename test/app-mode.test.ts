import { readFileSync } from "node:fs";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { LinkStore, makeLinkCode } from "../src/link-store.js";
import { InMemoryDeviceRegistry } from "../src/devices.js";
import { MockSessionVerifier } from "../src/auth.js";
import { Hub } from "../src/hub.js";
import { createRelayServer, type RelayServer } from "../src/server.js";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const indexHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const chatHtml = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");
const linkHtml = readFileSync(new URL("../web/link.html", import.meta.url), "utf8");
const authJs = readFileSync(new URL("../web/auth.js", import.meta.url), "utf8");
const themeCss = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");

const APP_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36 AFKPilotApp/1";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// pk_test_<base64("clerk.test$")> — auth.js derives the ClerkJS host from this.
const FAKE_PK = "pk_test_" + Buffer.from("clerk.test$").toString("base64");

function clerkStub(signedIn: boolean): string {
  const user = signedIn
    ? `{ primaryEmailAddress: { emailAddress: "me@example.com" }, id: "user_1" }`
    : "null";
  return `(function () {
    var user = ${user};
    window.Clerk = {
      user: user,
      session: user ? { getToken: function () { return Promise.resolve("not.a.jwt"); } } : null,
      load: function () { return Promise.resolve(); },
      mountUserButton: function (el, props) {
        window.__userButtonMounted = true;
        // Record what the page actually hands Clerk, so the test can assert
        // the Billing suppression rather than trusting the source read.
        window.__userButtonProps = props || null;
        if (el) el.innerHTML = '<div data-clerk-user-button="1">Manage account</div>';
      },
      mountPricingTable: function (el) {
        window.__pricingTableMounted = true;
        if (el) el.innerHTML = '<div data-clerk-pricing-table="1">Choose a plan</div>';
      },
      openSignIn: function () {},
      openUserProfile: function () {},
      addListener: function () {},
      signOut: function () { return Promise.resolve(); }
    };
  })();`;
}

async function painted(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].some((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }, selector);
}

async function paintedText(page: Page, pattern: string): Promise<string[]> {
  return page.evaluate((pat) => {
    const rx = new RegExp(pat, "i");
    const out: string[] = [];
    for (const el of document.querySelectorAll("a, button, [data-clerk-pricing-table], .plan-name, .usage-upgrade")) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (rx.test(t)) out.push(t);
    }
    return out;
  }, pattern);
}

describe("app-mode copy and detection (source)", () => {
  it("detects the shell by substring, never a version number", () => {
    // Every page that can mount Clerk's UserButton must stamp html.afk-app —
    // theme.css keys the Billing suppression off it.
    for (const [name, src] of [["index", indexHtml], ["chat", chatHtml], ["link", linkHtml], ["auth.js", authJs]] as const) {
      expect(src, `${name} must detect the shell`).toMatch(/\/AFKPilotApp\/\.test\(navigator\.userAgent\)/);
      expect(src, `${name} must not pin a version`).not.toMatch(/AFKPilotApp\/1/);
    }
    expect(themeCss).toMatch(/html\.afk-app \.cl-navbarButton__billing/);
  });

  // /link is a deep-link target for the shell, so Clerk's UserButton — and the
  // Billing tab inside UserProfile — is one tap away there too. Easy to lose
  // in a later edit because this page has no other app-mode behaviour.
  // UserProfile's Billing page is suppressed in ONE place — auth.js — because
  // index, chat and link all mount a user button and a per-page opt-in is one
  // forgotten page away from shipping a purchase surface. /link was that page
  // once already. So the contract is: no page may reach Clerk directly.
  it("routes every user-button mount through auth.js, which hides Billing", () => {
    expect(authJs).toMatch(/navbarButton__billing/);
    const props = authJs.slice(authJs.indexOf("function userButtonProps"));
    expect(props).toMatch(/if \(!inAppShell\(\)\) return undefined;/);
    expect(props).toMatch(/display:\s*"none"/);

    for (const [name, html] of [["link", linkHtml], ["index", indexHtml], ["chat", chatHtml]] as const) {
      const sites = [...html.matchAll(/^.*\.mountUserButton\(.*$/gm)];
      expect(sites.length, `${name}.html: expected exactly one user-button call site`).toBe(1);
      // It must go through the auth helper (auth./a.), never window.Clerk —
      // reaching Clerk directly would bypass the central Billing suppression.
      expect(sites[0]![0], `${name}.html must mount via the auth helper`).toMatch(
        /\b(auth|a)\.mountUserButton\(/,
      );
      expect(html, `${name}.html must not call clerk.mountUserButton directly`).not.toMatch(
        /(clerk|Clerk)\.mountUserButton\(/,
      );
    }
  });

  it("hides purchase and marketing surfaces in CSS, but not the usage meter", () => {
    expect(indexHtml).toMatch(/html\.afk-app #hero/);
    expect(indexHtml).toMatch(/html\.afk-app #billing/);
    expect(indexHtml).toMatch(/html\.afk-app #faq/);
    expect(indexHtml).toMatch(/html\.afk-app #install-btn/);
    expect(indexHtml).toMatch(/html\.afk-app #desktop-link/);
    expect(indexHtml).not.toMatch(/html\.afk-app #usage-meter/);
  });

  it("makes revealBilling a no-op in app mode before any Clerk pricing mount", () => {
    const start = indexHtml.indexOf("async function revealBilling");
    const end = indexHtml.indexOf("document.getElementById(\"picker-reauth\")", start);
    const body = indexHtml.slice(start, end);
    expect(body).toMatch(/if \(isAfkApp\(\)\) return;/);
    expect(body.indexOf("isAfkApp()")).toBeLessThan(body.indexOf("mountPricingTable"));
    expect(body.indexOf("isAfkApp()")).toBeLessThan(body.indexOf("manage-btn"));
  });
});

// The 4005 wall was not the only paywall moment, and an unsteered review found
// the two that were missed: the weekly-quota wall above the composer, and
// /link's 403 when a free user links a second computer. Both are ordinary
// free-tier journeys, not exotic ones. These pin every route that remains.
describe("no purchase route survives in app mode", () => {
  const serverTs = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

  it("the relay never puts an upgrade offer on the wire", () => {
    // bounce() copy is painted in EVERY client's transcript, so the relay
    // cannot carry merchandising without it reaching the app. Note the file
    // says "upgrade" constantly about WebSockets — only bounce text is scanned.
    const copy = [...serverTs.matchAll(/bounce\(\s*[`"]([^`"]*)[`"]/g)].map((m) => m[1]!);
    expect(copy.length, "expected to find the relay's bounce copy").toBeGreaterThan(2);
    for (const c of copy) {
      expect(c, `relay bounce copy offers an upgrade: ${c}`).not.toMatch(/upgrade|remote max/i);
    }
  });

  it("the weekly-quota wall drops its Upgrade link in the app", () => {
    const start = chatHtml.indexOf("function showQuotaWall");
    const body = chatHtml.slice(start, chatHtml.indexOf("document.body.classList.add(\"quota-exceeded\")", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/afk-app/);
    expect(body).toMatch(/Subscriptions aren't managed in the app/);
    // The app branch must be decided BEFORE the markup that carries the link.
    expect(body.indexOf("afk-app")).toBeLessThan(body.indexOf(">Upgrade</a>"));
    // window.open would leave the shell for the system browser — it must only
    // ever be reached through an anchor that app mode never renders.
    expect(body).toMatch(/if \(upgradeLink\)/);
  });

  it("link's device-limit and entitlement refusals drop their upgrade route", () => {
    const start = linkHtml.indexOf("res.status === 403");
    const body = linkHtml.slice(start, start + 1200);
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/afk-app/);
    expect(body.indexOf("afk-app")).toBeLessThan(body.indexOf("upgrade to Remote Max"));
    expect(body).toMatch(/Subscriptions aren't managed in the app/);
    // Device management is not a purchase, so it survives in both branches.
    expect(body).toMatch(/Remove the old device/);
  });
});

describe("4005 entitlement close copy", () => {
  const start = chatHtml.indexOf("function entitlementCloseCopy");
  const end = chatHtml.indexOf("function gateSignIn()", start);
  const entitlementCloseCopy = new Function(
    `${chatHtml.slice(start, end)}; return entitlementCloseCopy;`,
  )() as (appMode: boolean, queued: number | boolean) => string;

  it("keeps the upgrade link on the web, and names no destination in the app", () => {
    const web = entitlementCloseCopy(false, false);
    expect(web).toContain("Upgrade");
    expect(web).toContain('href="/"');
    expect(web).not.toMatch(/unsent message/i);

    const app = entitlementCloseCopy(true, false);
    expect(app).toMatch(/Remote Max/);
    expect(app).not.toMatch(/<a /i);
    expect(app).not.toMatch(/https?:/i);
    expect(app).not.toMatch(/afkpilot/i);
    expect(app).not.toMatch(/website/i);
    expect(app).not.toMatch(/href=/i);
    expect(app).not.toMatch(/unsent message/i);
  });

  it("keeps the unsent-message promise on both paths when the queue is held", () => {
    const saved = /unsent message is saved/i;
    expect(entitlementCloseCopy(false, 1)).toMatch(saved);
    expect(entitlementCloseCopy(true, 1)).toMatch(saved);
    expect(entitlementCloseCopy(true, 1)).not.toMatch(/<a /i);
  });
});

describe("app-mode landing page", () => {
  let relay: RelayServer;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    let n = 0;
    relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store: new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) }),
      devices: new InMemoryDeviceRegistry({
        now: Date.now,
        randomUUID: () => `kid-${++n}`,
        randomBytes: (size) => cryptoRandomBytes(size),
        randomId: () => `dev-${++n}`,
      }),
      sessions: new MockSessionVerifier(true),
      requiredFeature: undefined,
      hub: new Hub(),
      log: () => {},
    });
    await new Promise<void>((r) => relay.server.once("listening", () => r()));
    base = `http://127.0.0.1:${relay.port()}`;
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await relay?.close();
  });

  async function openLanding(opts: {
    userAgent: string;
    clerk?: { signedIn: boolean };
  }): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ userAgent: opts.userAgent });
    const page = await context.newPage();
    if (opts.clerk) {
      await page.route("**/api/config", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ publishableKey: FAKE_PK, requiredFeature: "remote_max" }),
        }),
      );
      await page.route("https://clerk.test/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: clerkStub(opts.clerk!.signedIn),
        }),
      );
    }
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    return { page, close: () => context.close() };
  }

  async function waitReady(page: Page) {
    await page.waitForFunction(() => !!(window as unknown as { grokAuth?: { ready: Promise<unknown> } }).grokAuth);
    await page.evaluate(() => (window as unknown as { grokAuth: { ready: Promise<unknown> } }).grokAuth.ready);
  }

  describe("signed-out (Clerk enabled)", () => {
    it("with AFKPilotApp: no pricing, no upgrade, no Clerk table — compact sign-in only", async () => {
      const { page, close } = await openLanding({ userAgent: APP_UA, clerk: { signedIn: false } });
      try {
        expect(await page.evaluate(() => document.documentElement.classList.contains("afk-app"))).toBe(true);
        // First-paint contract: CSS hides the hero even if JS were to unhide it.
        expect(
          await page.evaluate(() => {
            const hero = document.getElementById("hero") as HTMLElement;
            hero.hidden = false;
            return getComputedStyle(hero).display;
          }),
        ).toBe("none");

        await waitReady(page);
        expect(await page.evaluate(() => (window as unknown as { grokAuth: { enabled: boolean } }).grokAuth.enabled)).toBe(true);
        await page.waitForSelector("#app-signin:not([hidden])");

        expect(await painted(page, "#hero")).toBe(false);
        expect(await painted(page, "#pricing-section")).toBe(false);
        expect(await painted(page, "#billing")).toBe(false);
        expect(await painted(page, "#pricing")).toBe(false);
        expect(await painted(page, "[data-clerk-pricing-table]")).toBe(false);
        expect(await painted(page, "#manage-btn")).toBe(false);
        expect(await painted(page, "#faq")).toBe(false);
        expect(await painted(page, "#install-btn")).toBe(false);
        expect(await painted(page, "#desktop-link")).toBe(false);
        expect(await painted(page, ".usage-upgrade")).toBe(false);
        expect(await paintedText(page, "see pricing")).toEqual([]);
        expect(await paintedText(page, "start free")).toEqual([]);
        expect(await paintedText(page, "upgrade")).toEqual([]);
        expect(await paintedText(page, "manage subscription")).toEqual([]);
        expect(await paintedText(page, "choose a plan")).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { __pricingTableMounted?: boolean }).__pricingTableMounted)).toBeUndefined();

        expect(await painted(page, "#app-signin")).toBe(true);
        expect(await paintedText(page, "^sign in$")).toContain("Sign in");
      } finally {
        await close();
      }
    }, 30_000);

    it("without AFKPilotApp: pricing, upgrade CTAs, and the pricing section still render", async () => {
      const { page, close } = await openLanding({ userAgent: BROWSER_UA, clerk: { signedIn: false } });
      try {
        expect(await page.evaluate(() => document.documentElement.classList.contains("afk-app"))).toBe(false);
        await waitReady(page);
        expect(await page.evaluate(() => (window as unknown as { grokAuth: { enabled: boolean } }).grokAuth.enabled)).toBe(true);
        await page.waitForSelector("#hero:not([hidden])");

        expect(await painted(page, "#hero")).toBe(true);
        expect(await painted(page, "#pricing-section")).toBe(true);
        expect(await paintedText(page, "see pricing")).not.toEqual([]);
        expect(await paintedText(page, "start free")).not.toEqual([]);
        expect(await paintedText(page, "sign in to upgrade")).not.toEqual([]);
        expect(await painted(page, "#app-signin")).toBe(false);
        expect(await painted(page, "#faq")).toBe(true);
      } finally {
        await close();
      }
    }, 30_000);
  });

  describe("signed-in unentitled (Clerk enabled)", () => {
    it("with AFKPilotApp: no pricing table, and UserProfile is told to hide Billing", async () => {
      const { page, close } = await openLanding({ userAgent: APP_UA, clerk: { signedIn: true } });
      try {
        await waitReady(page);
        await page.waitForSelector("#picker:not([hidden])");

        expect(await painted(page, "#billing")).toBe(false);
        expect(await painted(page, "#pricing-section")).toBe(false);
        expect(await painted(page, "[data-clerk-pricing-table]")).toBe(false);
        expect(await painted(page, "#manage-btn")).toBe(false);
        expect(await paintedText(page, "upgrade")).toEqual([]);
        expect(await paintedText(page, "manage subscription")).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { __pricingTableMounted?: boolean }).__pricingTableMounted)).toBeUndefined();

        // Account management stays — only the purchase surface goes. This is
        // the runtime half of the contract: what the page hands Clerk, not
        // what the source looks like.
        expect(await page.evaluate(() => (window as unknown as { __userButtonMounted?: boolean }).__userButtonMounted)).toBe(true);
        expect(await painted(page, "[data-clerk-user-button]")).toBe(true);
        const props = await page.evaluate(() => (window as unknown as { __userButtonProps?: unknown }).__userButtonProps);
        expect(props).toMatchObject({
          userProfileProps: { appearance: { elements: { navbarButton__billing: { display: "none" } } } },
        });

        expect(await painted(page, "#signed-in-as")).toBe(true);
        expect(await painted(page, "#faq")).toBe(false);
        expect(await painted(page, ".app-hidden")).toBe(false);
      } finally {
        await close();
      }
    }, 30_000);

    it("without AFKPilotApp: Clerk pricing table still mounts", async () => {
      const { page, close } = await openLanding({ userAgent: BROWSER_UA, clerk: { signedIn: true } });
      try {
        await waitReady(page);
        await page.waitForSelector("#picker:not([hidden])");
        await page.waitForFunction(() => (window as unknown as { __pricingTableMounted?: boolean }).__pricingTableMounted === true);

        expect(await painted(page, "#billing")).toBe(true);
        expect(await painted(page, "[data-clerk-pricing-table]")).toBe(true);
        expect(await paintedText(page, "choose a plan")).not.toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { __userButtonMounted?: boolean }).__userButtonMounted)).toBe(true);
        // A normal browser must get Clerk's UserProfile untouched — no
        // appearance override, so Billing stays exactly where it was.
        expect(await page.evaluate(() => (window as unknown as { __userButtonProps?: unknown }).__userButtonProps)).toBeNull();
        expect(await painted(page, "#faq")).toBe(true);
        expect(await painted(page, ".app-hidden")).toBe(true);
      } finally {
        await close();
      }
    }, 30_000);
  });

  describe("mock auth (no Clerk)", () => {
    it("with AFKPilotApp: picker works, marketing stays gone, no throw", async () => {
      const { page, close } = await openLanding({ userAgent: APP_UA });
      try {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await waitReady(page);
        await page.waitForSelector("#picker:not([hidden])");
        expect(await page.evaluate(() => (window as unknown as { grokAuth: { enabled: boolean } }).grokAuth.enabled)).toBe(false);
        expect(await painted(page, "#hero")).toBe(false);
        expect(await painted(page, "#pricing-section")).toBe(false);
        expect(await painted(page, "#billing")).toBe(false);
        expect(await painted(page, "#faq")).toBe(false);
        expect(await painted(page, "#app-signin")).toBe(false);
        expect(await painted(page, "#picker")).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 30_000);

    it("without AFKPilotApp: FAQ still renders in mock mode", async () => {
      const { page, close } = await openLanding({ userAgent: BROWSER_UA });
      try {
        await waitReady(page);
        await page.waitForSelector("#picker:not([hidden])");
        expect(await painted(page, "#faq")).toBe(true);
        expect(await painted(page, "#hero")).toBe(false); // mock never shows marketing
        expect(await painted(page, "#app-signin")).toBe(false);
      } finally {
        await close();
      }
    }, 30_000);
  });
});
