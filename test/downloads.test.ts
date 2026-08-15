import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_PLATFORMS,
  downloadPlatformFromPath,
  resolveDownload,
  type ReleaseLike,
} from "../src/downloads.js";

const installer = (v: string, suffix: string) => ({
  name: `Grok-Build-Desktop-${v}${suffix}`,
  browser_download_url: `https://github.com/phuryn/grok-build-vscode/releases/download/v${v}/Grok-Build-Desktop-${v}${suffix}`,
  size: 100,
});

/** Every platform's installer, the way a complete release looks. */
const full = (v: string, extra: unknown[] = []): ReleaseLike => ({
  tag_name: `v${v}`,
  draft: false,
  assets: [
    installer(v, "-win-x64.exe"),
    installer(v, "-mac-arm64.dmg"),
    installer(v, "-mac-x64.dmg"),
    // The noise a real release carries, and none of it is a download.
    { name: `Grok-Build-Desktop-${v}-win-x64.exe.blockmap`, browser_download_url: "x", size: 1 },
    { name: `Grok-Build-Desktop-${v}-mac-arm64.zip`, browser_download_url: "x", size: 1 },
    { name: `grok-vscode-phuryn-${v}.vsix`, browser_download_url: "x", size: 1 },
    ...extra,
  ] as ReleaseLike["assets"],
});

describe("resolving /download/<platform>", () => {
  it("answers each platform from the newest complete release", () => {
    const releases = [full("3.2.4"), full("3.2.3")];
    for (const key of Object.keys(DOWNLOAD_PLATFORMS)) {
      const hit = resolveDownload(releases, key);
      expect(hit?.version).toBe("3.2.4");
      expect(hit?.url).toContain(`Grok-Build-Desktop-3.2.4${DOWNLOAD_PLATFORMS[key]}`);
    }
  });

  it("never offers a .blockmap or the vsix", () => {
    // Anchored suffixes: `…-win-x64.exe.blockmap` ends with neither, and the
    // vsix is the extension, not the app. Offering either is a broken download
    // that looks like a working one.
    const hit = resolveDownload([full("3.2.4")], "win-x64");
    expect(hit?.url.endsWith(".exe")).toBe(true);
    expect(hit?.url).not.toContain("blockmap");
    expect(hit?.url).not.toContain(".vsix");
  });

  it("falls through an extension-only release to the newest one with installers", () => {
    // A patch that ships only the vsix must not blank the desktop downloads.
    const vsixOnly: ReleaseLike = {
      tag_name: "v3.2.5", draft: false,
      assets: [{ name: "grok-vscode-phuryn-3.2.5.vsix", browser_download_url: "x", size: 1 }],
    };
    expect(resolveDownload([vsixOnly, full("3.2.4")], "win-x64")?.version).toBe("3.2.4");
  });

  it("skips a release whose installers are only half there", () => {
    // A macOS job that failed leaves Windows assets attached. Serving that
    // release to Windows while Mac silently drops to an older one puts two
    // different versions on the same page — either it is current or it is not.
    const halfDone: ReleaseLike = {
      tag_name: "v3.2.5", draft: false,
      assets: [installer("3.2.5", "-win-x64.exe")] as ReleaseLike["assets"],
    };
    expect(resolveDownload([halfDone, full("3.2.4")], "win-x64")?.version).toBe("3.2.4");
    expect(resolveDownload([halfDone, full("3.2.4")], "mac-arm64")?.version).toBe("3.2.4");
  });

  it("skips drafts, whose assets 404 for anonymous downloads", () => {
    const draft = { ...full("3.2.5"), draft: true };
    expect(resolveDownload([draft, full("3.2.4")], "win-x64")?.version).toBe("3.2.4");
  });

  it("counts pre-releases — the desktop app ships that way while unsigned", () => {
    const pre = { ...full("3.3.0"), prerelease: true } as ReleaseLike;
    expect(resolveDownload([pre, full("3.2.4")], "win-x64")?.version).toBe("3.3.0");
  });

  it("returns null rather than guessing", () => {
    expect(resolveDownload([], "win-x64")).toBeNull();
    expect(resolveDownload(null, "win-x64")).toBeNull();
    expect(resolveDownload([full("3.2.4")], "linux-x64")).toBeNull();
  });
});

describe("the /download path", () => {
  it("accepts exactly the platforms we publish", () => {
    expect(downloadPlatformFromPath("/download/win-x64")).toBe("win-x64");
    expect(downloadPlatformFromPath("/download/mac-arm64")).toBe("mac-arm64");
    expect(downloadPlatformFromPath("/download/mac-x64")).toBe("mac-x64");
  });

  it("refuses anything else, including path tricks", () => {
    for (const p of [
      "/download", "/download/", "/download/linux", "/download/win-x64/",
      "/download/../../etc/passwd", "/download/%2e%2e", "/downloads/win-x64",
    ]) {
      expect(downloadPlatformFromPath(p)).toBeNull();
    }
  });
});
