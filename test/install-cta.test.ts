import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Behavioural, not a source-shape guard: the real function is sliced out of the
 * page and run against real user-agent strings. It exists because the rule it
 * encodes is one nobody can check by reading — iPadOS Safari reports a
 * *Macintosh* user agent, so "is this a tablet" and "does /iPad/ match" answer
 * differently about the same device, and a version of this page that asked both
 * questions separately showed an iPad NO call to action at all.
 */
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

const start = html.indexOf("function chooseInstallCta(env)");
const end = html.indexOf("function installCta()");
const source = html.slice(start, end);

type Env = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  hasPrompt?: boolean;
};
const chooseInstallCta = new Function(
  `${source}; return chooseInstallCta;`,
)() as (env: Env) => string;

// Real strings, not invented ones — the whole defect was a guess about shapes.
const UA = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  // iPadOS Safari. Identical to `mac` above — only maxTouchPoints tells them apart.
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Mobile Safari/537.36",
  chromeos:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
};

describe("install CTA — exactly one, chosen by what the device can run", () => {
  it("offers the native app to computers, prompt or no prompt", () => {
    expect(chooseInstallCta({ userAgent: UA.windows, platform: "Win32", maxTouchPoints: 0 })).toBe("desktop");
    expect(chooseInstallCta({ userAgent: UA.mac, platform: "MacIntel", maxTouchPoints: 0 })).toBe("desktop");
    // A Windows tablet: coarse pointer, ten touch points — and perfectly able to
    // run the installer. "Touch" was never the right question.
    expect(chooseInstallCta({ userAgent: UA.windows, platform: "Win32", maxTouchPoints: 10 })).toBe("desktop");
    // Even with a PWA prompt in hand, a computer is not offered the web app.
    expect(
      chooseInstallCta({ userAgent: UA.windows, platform: "Win32", maxTouchPoints: 0, hasPrompt: true }),
    ).toBe("desktop");
  });

  it("offers the web app to an iPad, whose UA claims to be a Mac", () => {
    // The regression: MacIntel + touch points said "not a computer", while the
    // /iPad/ test said "not iOS" — so neither CTA was ever revealed.
    expect(chooseInstallCta({ userAgent: UA.ipad, platform: "MacIntel", maxTouchPoints: 5 })).toBe("web-ios");
  });

  it("offers the web app to phones, by the route their browser supports", () => {
    expect(chooseInstallCta({ userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5 })).toBe("web-ios");
    // Android fires beforeinstallprompt; before it arrives there is nothing to
    // offer, and no reason to advertise an .exe it cannot run.
    expect(chooseInstallCta({ userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe("none");
    expect(
      chooseInstallCta({ userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5, hasPrompt: true }),
    ).toBe("web");
  });

  it("treats ChromeOS as a device with no native build to offer", () => {
    expect(
      chooseInstallCta({ userAgent: UA.chromeos, platform: "Linux x86_64", maxTouchPoints: 0, hasPrompt: true }),
    ).toBe("web");
  });

  it("offers nothing once the web app is already installed", () => {
    expect(
      chooseInstallCta({ userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5, standalone: true }),
    ).toBe("none");
    expect(
      chooseInstallCta({
        userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5,
        standalone: true, hasPrompt: true,
      }),
    ).toBe("none");
  });

  it("never returns a computer CTA and a web CTA for the same device", () => {
    const devices: Env[] = [
      { userAgent: UA.windows, platform: "Win32", maxTouchPoints: 0 },
      { userAgent: UA.windows, platform: "Win32", maxTouchPoints: 10 },
      { userAgent: UA.mac, platform: "MacIntel", maxTouchPoints: 0 },
      { userAgent: UA.ipad, platform: "MacIntel", maxTouchPoints: 5 },
      { userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5 },
      { userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5, hasPrompt: true },
      { userAgent: UA.chromeos, platform: "Linux x86_64", maxTouchPoints: 0, hasPrompt: true },
    ];
    for (const d of devices) {
      const kind = chooseInstallCta(d);
      expect(["desktop", "web", "web-ios", "none"]).toContain(kind);
    }
    // And every device capable of running the host gets exactly the native one.
    expect(devices.filter((d) => chooseInstallCta(d) === "desktop")).toHaveLength(3);
  });
});
