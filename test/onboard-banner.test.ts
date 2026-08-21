import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Behavioural extract of the chat onboarding banner. linked=1 is a real
 * just-linked event; remoteHint=1 is only an install nudge. The two used to
 * share the heading "Device linked", which is false for the picker / Continue
 * remotely path.
 */
const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const start = html.indexOf("function isStandaloneDisplay(env)");
const end = html.indexOf("function persistStandaloneInstall()");
const source = html.slice(start, end);

type ConsumeResult = { linked: boolean; remoteHint: boolean };
type OnboardKind = "none" | "linked" | "hint";
type DecideInput = {
  linked?: boolean;
  remoteHint?: boolean;
  standalone?: boolean;
  dismissed?: boolean;
  installed?: boolean;
};

const {
  isStandaloneDisplay,
  consumeOnboardParams,
  decideOnboardKind,
  onboardBannerTitle,
  onboardCloseLabel,
} = new Function(
  `${source}; return {
    isStandaloneDisplay,
    consumeOnboardParams,
    decideOnboardKind,
    onboardBannerTitle,
    onboardCloseLabel,
  };`,
)() as {
  isStandaloneDisplay: (env: { standalone?: boolean; iosStandalone?: boolean }) => boolean;
  consumeOnboardParams: (
    search: string,
    pathname: string,
    hash: string,
    replaceState: (state: unknown, title: string, url: string) => void,
  ) => ConsumeResult;
  decideOnboardKind: (input: DecideInput) => OnboardKind;
  onboardBannerTitle: (kind: OnboardKind, mobile: boolean) => string;
  onboardCloseLabel: (kind: OnboardKind) => string;
};

describe("onboard param consumption — strip the trigger, keep the rest", () => {
  it("strips linked=1 and remoteHint=1, together or apart", () => {
    const urls: string[] = [];
    const replace = (_s: unknown, _t: string, url: string) => { urls.push(url); };

    expect(consumeOnboardParams("?device=abc&linked=1", "/chat", "", replace))
      .toEqual({ linked: true, remoteHint: false });
    expect(consumeOnboardParams("?device=abc&remoteHint=1", "/chat", "", replace))
      .toEqual({ linked: false, remoteHint: true });
    expect(consumeOnboardParams("?device=abc&linked=1&remoteHint=1", "/chat", "#x", replace))
      .toEqual({ linked: true, remoteHint: true });
    expect(urls).toEqual([
      "/chat?device=abc",
      "/chat?device=abc",
      "/chat?device=abc#x",
    ]);
  });

  it("leaves the URL alone when neither trigger is present", () => {
    const urls: string[] = [];
    expect(consumeOnboardParams("?device=abc", "/chat", "", (_s, _t, url) => { urls.push(url); }))
      .toEqual({ linked: false, remoteHint: false });
    expect(urls).toEqual([]);
  });
});

describe("onboard kind — a real link vs an install nudge vs nothing", () => {
  it("shows the linked banner for linked=1, even after a dismissed or installed hint", () => {
    expect(decideOnboardKind({ linked: true })).toBe("linked");
    expect(decideOnboardKind({ linked: true, dismissed: true, installed: true })).toBe("linked");
    expect(decideOnboardKind({ linked: true, remoteHint: true, dismissed: true })).toBe("linked");
  });

  it("shows the hint only for remoteHint=1 that has not been waved away", () => {
    expect(decideOnboardKind({ remoteHint: true })).toBe("hint");
    expect(decideOnboardKind({ remoteHint: true, dismissed: true })).toBe("none");
    expect(decideOnboardKind({ remoteHint: true, installed: true })).toBe("none");
    expect(decideOnboardKind({ remoteHint: true, dismissed: true, installed: true })).toBe("none");
  });

  it("shows nothing in standalone display mode, including a genuine new link", () => {
    expect(decideOnboardKind({ linked: true, standalone: true })).toBe("none");
    expect(decideOnboardKind({ remoteHint: true, standalone: true })).toBe("none");
    expect(isStandaloneDisplay({ standalone: true })).toBe(true);
    expect(isStandaloneDisplay({ iosStandalone: true })).toBe(true);
    expect(isStandaloneDisplay({})).toBe(false);
  });

  it("shows nothing without a trigger", () => {
    expect(decideOnboardKind({})).toBe("none");
  });
});

describe("onboard copy — remoteHint must not claim a device just linked", () => {
  it("keeps today's linked heading", () => {
    expect(onboardBannerTitle("linked", true)).toBe("Device linked");
    expect(onboardBannerTitle("linked", false)).toBe("Device linked");
    expect(onboardCloseLabel("linked")).toBe("Dismiss device linked message");
  });

  it("names the install nudge without claiming a link", () => {
    expect(onboardBannerTitle("hint", true)).toBe("Install AFK Pilot");
    expect(onboardBannerTitle("hint", false)).toBe("Use it on your phone");
    expect(onboardBannerTitle("hint", true)).not.toMatch(/Device linked/i);
    expect(onboardBannerTitle("hint", false)).not.toMatch(/Device linked/i);
    expect(onboardCloseLabel("hint")).toBe("Dismiss install suggestion");
  });
});
