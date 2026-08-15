import { describe, expect, it } from "vitest";
import { type ReleaseLike } from "../src/downloads.js";
import {
  GITHUB_RELEASE_DOWNLOAD,
  rewriteUpdateYml,
  updateFeedFromPath,
  updateYmlCandidates,
  ymlReferencesKnownAssets,
} from "../src/update-feed.js";

const SHA512_WIN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop==";
const SHA512_ARM = "ARM64SHA512VALUE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV==";
const SHA512_X64 = "X64SHA512VALUE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX==";

const winYml = (v: string) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-win-x64.exe`,
    `    sha512: ${SHA512_WIN}`,
    "    size: 84167424",
    `path: Grok-Build-Desktop-${v}-win-x64.exe`,
    `sha512: ${SHA512_WIN}`,
    "releaseDate: '2026-08-13T13:01:24.000Z'",
    "",
  ].join("\n");

const macYml = (v: string) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `    sha512: ${SHA512_ARM}`,
    "    size: 97735494",
    `  - url: Grok-Build-Desktop-${v}-mac-x64.zip`,
    `    sha512: ${SHA512_X64}`,
    "    size: 104268091",
    `path: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `sha512: ${SHA512_ARM}`,
    "releaseDate: '2026-08-13T13:04:06.000Z'",
    "",
  ].join("\n");

const macOneArchYml = (v: string) =>
  [
    `version: ${v}`,
    "files:",
    `  - url: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `    sha512: ${SHA512_ARM}`,
    "    size: 1",
    `path: Grok-Build-Desktop-${v}-mac-arm64.zip`,
    `sha512: ${SHA512_ARM}`,
    "releaseDate: '2026-08-14T00:00:00.000Z'",
    "",
  ].join("\n");

const asset = (name: string) => ({
  name,
  browser_download_url: `${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/${name}`,
  size: 1,
});

const desktopRelease = (v: string, extra: { name: string }[] = []): ReleaseLike => ({
  tag_name: `v${v}`,
  draft: false,
  assets: [
    asset(`Grok-Build-Desktop-${v}-win-x64.exe`),
    asset(`Grok-Build-Desktop-${v}-win-x64.exe.blockmap`),
    asset(`Grok-Build-Desktop-${v}-mac-arm64.dmg`),
    asset(`Grok-Build-Desktop-${v}-mac-arm64.zip`),
    asset(`Grok-Build-Desktop-${v}-mac-x64.dmg`),
    asset(`Grok-Build-Desktop-${v}-mac-x64.zip`),
    asset("latest.yml"),
    asset("latest-mac.yml"),
    asset(`grok-vscode-phuryn-${v}.vsix`),
    ...extra,
  ],
});

const vsixOnly = (v: string): ReleaseLike => ({
  tag_name: `v${v}`,
  draft: false,
  assets: [asset(`grok-vscode-phuryn-${v}.vsix`)],
});

describe("updateFeedFromPath", () => {
  it("accepts exactly the two channel files the client GETs", () => {
    expect(updateFeedFromPath("/update/win/latest.yml")).toBe("win");
    expect(updateFeedFromPath("/update/mac/latest-mac.yml")).toBe("mac");
  });

  it("refuses everything else, including path tricks and the installers themselves", () => {
    for (const p of [
      "/update/win/latest.yml/",
      "/update/win/LATEST.YML",
      "/update/win/",
      "/update/win",
      "/update/mac/latest.yml",
      "/update/win/Grok-Build-Desktop-3.7.0-win-x64.exe",
      "/update/win/latest.yml.blockmap",
      "/update/../win/latest.yml",
      "/download/win-x64",
    ]) {
      expect(updateFeedFromPath(p)).toBeNull();
    }
  });
});

describe("updateYmlCandidates", () => {
  it("picks the newest non-draft desktop release that carries the channel yml", () => {
    const releases = [desktopRelease("3.7.0"), desktopRelease("3.6.0")];
    expect(updateYmlCandidates(releases, "win").map((c) => c.tag)).toEqual(["v3.7.0", "v3.6.0"]);
    const win = updateYmlCandidates(releases, "win")[0];
    expect(win.url).toBe(`${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/latest.yml`);
    expect(win.assets).toContain("Grok-Build-Desktop-3.7.0-win-x64.exe");
    expect(win.assets).toContain("latest.yml");
    expect(updateYmlCandidates(releases, "mac")[0].url).toBe(
      `${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/latest-mac.yml`,
    );
  });

  it("skips a vsix-only latest and keeps older installer-bearing releases", () => {
    const releases = [vsixOnly("3.8.0"), desktopRelease("3.7.0")];
    expect(updateYmlCandidates(releases, "win").map((c) => c.tag)).toEqual(["v3.7.0"]);
    expect(updateYmlCandidates(releases, "mac").map((c) => c.tag)).toEqual(["v3.7.0"]);
  });

  it("skips drafts, whose assets 404 for anonymous downloads", () => {
    const releases = [{ ...desktopRelease("3.8.0"), draft: true }, desktopRelease("3.7.0")];
    expect(updateYmlCandidates(releases, "win").map((c) => c.tag)).toEqual(["v3.7.0"]);
  });

  it("counts pre-releases — the desktop app ships that way while unsigned", () => {
    const releases = [{ ...desktopRelease("3.8.0"), prerelease: true } as ReleaseLike, desktopRelease("3.7.0")];
    expect(updateYmlCandidates(releases, "win")[0].tag).toBe("v3.8.0");
  });

  it("skips a release that has installers but no channel yml — sha512 cannot be invented", () => {
    const noYml: ReleaseLike = {
      tag_name: "v3.7.0",
      draft: false,
      assets: [
        asset("Grok-Build-Desktop-3.7.0-win-x64.exe"),
        asset("Grok-Build-Desktop-3.7.0-mac-arm64.zip"),
        asset("Grok-Build-Desktop-3.7.0-mac-x64.zip"),
      ],
    };
    expect(updateYmlCandidates([noYml], "win")).toEqual([]);
    expect(updateYmlCandidates([noYml], "mac")).toEqual([]);
  });

  it("does not treat a .blockmap as the Windows installer", () => {
    const onlyBlockmap: ReleaseLike = {
      tag_name: "v3.8.0",
      draft: false,
      assets: [asset("Grok-Build-Desktop-3.8.0-win-x64.exe.blockmap"), asset("latest.yml")],
    };
    expect(updateYmlCandidates([onlyBlockmap, desktopRelease("3.7.0")], "win").map((c) => c.tag)).toEqual([
      "v3.7.0",
    ]);
  });

  it("requires both mac zip arches on the release before the yml is even fetched", () => {
    const oneZip: ReleaseLike = {
      tag_name: "v3.8.0",
      draft: false,
      assets: [
        asset("Grok-Build-Desktop-3.8.0-mac-arm64.zip"),
        asset("latest-mac.yml"),
      ],
    };
    expect(updateYmlCandidates([oneZip, desktopRelease("3.7.0")], "mac").map((c) => c.tag)).toEqual([
      "v3.7.0",
    ]);
  });

  it("selects independently per channel — a win-only upload can still feed Windows", () => {
    const winOnly: ReleaseLike = {
      tag_name: "v3.8.0",
      draft: false,
      assets: [asset("Grok-Build-Desktop-3.8.0-win-x64.exe"), asset("latest.yml")],
    };
    const releases = [winOnly, desktopRelease("3.7.0")];
    expect(updateYmlCandidates(releases, "win")[0].tag).toBe("v3.8.0");
    expect(updateYmlCandidates(releases, "mac")[0].tag).toBe("v3.7.0");
  });

  it("returns nothing rather than guessing", () => {
    expect(updateYmlCandidates([], "win")).toEqual([]);
    expect(updateYmlCandidates(null, "mac")).toEqual([]);
    expect(updateYmlCandidates(undefined, "win")).toEqual([]);
  });

  it("rejects a tag that would escape the download URL", () => {
    const bad: ReleaseLike = { ...desktopRelease("3.7.0"), tag_name: "v3.7.0/../../../latest" };
    expect(updateYmlCandidates([bad], "win")).toEqual([]);
  });
});

describe("rewriteUpdateYml", () => {
  it("rewrites files[].url and the legacy top-level path, leaving checksums alone", () => {
    const out = rewriteUpdateYml(winYml("3.7.0"), "v3.7.0", "win");
    expect(out).toContain(
      `  - url: ${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe`,
    );
    expect(out).toContain(
      `path: ${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe`,
    );
    expect(out).toContain(`    sha512: ${SHA512_WIN}`);
    expect(out).toContain(`sha512: ${SHA512_WIN}`);
    expect(out).toContain("    size: 84167424");
    expect(out).toContain("version: 3.7.0");
    expect(out).toContain("releaseDate: '2026-08-13T13:01:24.000Z'");
    expect(out).not.toContain("blockmap");
  });

  it("rewrites both mac zip urls and still lists both arches", () => {
    const out = rewriteUpdateYml(macYml("3.7.0"), "v3.7.0", "mac");
    expect(out).toContain(
      `${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-mac-arm64.zip`,
    );
    expect(out).toContain(
      `${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-mac-x64.zip`,
    );
    expect(out).toContain(`    sha512: ${SHA512_ARM}`);
    expect(out).toContain(`    sha512: ${SHA512_X64}`);
  });

  it("refuses a one-arch mac yml rather than publishing a half feed", () => {
    expect(rewriteUpdateYml(macOneArchYml("3.8.0"), "v3.8.0", "mac")).toBeNull();
  });

  it("refuses a Windows yml that does not list the NSIS installer", () => {
    const bogus = "version: 1.0.0\nfiles:\n  - url: something.vsix\n    sha512: x\n    size: 1\n";
    expect(rewriteUpdateYml(bogus, "v1.0.0", "win")).toBeNull();
  });

  it("does not treat a .blockmap name as the installer", () => {
    const onlyMap = [
      "version: 3.7.0",
      "files:",
      "  - url: Grok-Build-Desktop-3.7.0-win-x64.exe.blockmap",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "",
    ].join("\n");
    expect(rewriteUpdateYml(onlyMap, "v3.7.0", "win")).toBeNull();
  });

  it("preserves quoting and does not re-emit YAML", () => {
    const quoted = '  - url: "Grok-Build-Desktop-3.7.0-win-x64.exe"\n';
    const out = rewriteUpdateYml(quoted, "v3.7.0", "win");
    expect(out).toBe(
      `  - url: "${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe"\n`,
    );
  });

  it("preserves CRLF so a Windows-built yml does not change line endings", () => {
    const crlf = winYml("3.7.0").replace(/\n/g, "\r\n");
    const out = rewriteUpdateYml(crlf, "v3.7.0", "win");
    expect(out).toBeTruthy();
    expect(out).toContain("\r\n");
    expect(out!.includes("\n") && !out!.includes("\r\n")).toBe(false);
    expect(out).toContain(`sha512: ${SHA512_WIN}\r\n`);
  });

  it("leaves already-absolute urls alone when they are GitHub download URLs (no double prefix)", () => {
    const abs = `  - url: ${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe\n`;
    expect(rewriteUpdateYml(abs, "v3.7.0", "win")).toBe(abs);
  });

  it("rejects an absolute url that is not the GitHub download prefix", () => {
    const abs = [
      "version: 3.7.0",
      "files:",
      "  - url: https://evil.example/Grok-Build-Desktop-3.7.0-win-x64.exe",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "",
    ].join("\n");
    expect(rewriteUpdateYml(abs, "v3.7.0", "win")).toBeNull();
  });

  it("rejects the whole yml when one url is a foreign absolute even if another is relative", () => {
    const mixed = [
      "version: 3.7.0",
      "files:",
      "  - url: Grok-Build-Desktop-3.7.0-win-x64.exe",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "  - url: https://cdn.example/extra.exe",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "",
    ].join("\n");
    expect(rewriteUpdateYml(mixed, "v3.7.0", "win")).toBeNull();
  });

  it("rejects an http (non-https) GitHub-looking download url", () => {
    const http = `  - url: http://github.com/phuryn/grok-build-vscode/releases/download/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe\n`;
    expect(rewriteUpdateYml(http, "v3.7.0", "win")).toBeNull();
  });

  it("does not rewrite a sha512 line even if the value looks like a path", () => {
    const yml = [
      "version: 3.7.0",
      "files:",
      "  - url: Grok-Build-Desktop-3.7.0-win-x64.exe",
      "    sha512: Grok-Build-Desktop-3.7.0-win-x64.exe",
      "    size: 1",
      "",
    ].join("\n");
    const out = rewriteUpdateYml(yml, "v3.7.0", "win");
    expect(out).toContain("    sha512: Grok-Build-Desktop-3.7.0-win-x64.exe");
    expect(out).not.toMatch(/sha512: https:\/\//);
  });

  it("does not invent blockmap entries", () => {
    const out = rewriteUpdateYml(winYml("3.7.0"), "v3.7.0", "win");
    expect(out).not.toMatch(/blockmap/i);
    expect(out?.split(/\r?\n/).filter((l) => /^\s*- /.test(l))).toHaveLength(1);
  });

  it("rejects HTML (a GitHub error page must not go out as a feed)", () => {
    expect(rewriteUpdateYml("<!doctype html><html><body>nope</body></html>", "v3.7.0", "win")).toBeNull();
    expect(rewriteUpdateYml("<html>rate limited</html>", "v3.7.0", "mac")).toBeNull();
  });

  it("rejects empty / missing input rather than serving an empty 200", () => {
    expect(rewriteUpdateYml("", "v3.7.0", "win")).toBeNull();
    expect(rewriteUpdateYml("   \n", "v3.7.0", "win")).toBeNull();
    expect(rewriteUpdateYml(null, "v3.7.0", "win")).toBeNull();
  });

  it("leaves a trailing comment on a url line attached to that line", () => {
    const yml = "  - url: Grok-Build-Desktop-3.7.0-win-x64.exe  # nsis\n";
    const out = rewriteUpdateYml(yml, "v3.7.0", "win");
    expect(out).toBe(
      `  - url: ${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe  # nsis\n`,
    );
  });

  it("does not rewrite a name that would change the download path", () => {
    const yml = "  - url: ../evil.exe\n  - url: Grok-Build-Desktop-3.7.0-win-x64.exe\n";
    const out = rewriteUpdateYml(yml, "v3.7.0", "win");
    expect(out).toContain("  - url: ../evil.exe");
    expect(out).toContain(`${GITHUB_RELEASE_DOWNLOAD}/v3.7.0/Grok-Build-Desktop-3.7.0-win-x64.exe`);
  });
});

describe("ymlReferencesKnownAssets", () => {
  const namesOf = (v: string) =>
    (desktopRelease(v).assets ?? []).map((a) => a.name as string);

  it("accepts a rewritten yml whose url/path filenames exist on that release", () => {
    const out = rewriteUpdateYml(winYml("3.7.0"), "v3.7.0", "win");
    expect(out).toBeTruthy();
    expect(ymlReferencesKnownAssets(out!, namesOf("3.7.0"))).toBe(true);
  });

  it("rejects a stale yml rewritten against a newer tag whose assets do not include those names", () => {
    const staleOnNewerTag = rewriteUpdateYml(winYml("3.7.0"), "v3.8.0", "win");
    expect(staleOnNewerTag).toBeTruthy();
    expect(ymlReferencesKnownAssets(staleOnNewerTag!, namesOf("3.8.0"))).toBe(false);
  });

  it("rejects when any referenced filename is missing, even if the required installer is present", () => {
    const yml = [
      "version: 3.7.0",
      "files:",
      "  - url: Grok-Build-Desktop-3.7.0-win-x64.exe",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "  - url: leftover-from-old-build.exe",
      `    sha512: ${SHA512_WIN}`,
      "    size: 1",
      "",
    ].join("\n");
    const out = rewriteUpdateYml(yml, "v3.7.0", "win");
    expect(out).toBeTruthy();
    expect(ymlReferencesKnownAssets(out!, namesOf("3.7.0"))).toBe(false);
  });

  it("rejects an otherwise-rewritten yml with no url/path lines against an empty asset list", () => {
    expect(ymlReferencesKnownAssets("version: 3.7.0\n", ["latest.yml"])).toBe(false);
    expect(ymlReferencesKnownAssets(rewriteUpdateYml(winYml("3.7.0"), "v3.7.0", "win")!, [])).toBe(
      false,
    );
  });

  it("rejects a leftover relative name the rewriter left untouched", () => {
    const yml = "  - url: ../evil.exe\n  - url: Grok-Build-Desktop-3.7.0-win-x64.exe\n";
    const out = rewriteUpdateYml(yml, "v3.7.0", "win");
    expect(out).toBeTruthy();
    expect(ymlReferencesKnownAssets(out!, namesOf("3.7.0"))).toBe(false);
  });
});
