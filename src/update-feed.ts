/**
 * Desktop auto-update channel files (`latest.yml` / `latest-mac.yml`).
 *
 * Pure — no network, no fs. The impure half (GitHub fetch, in-memory cache,
 * HTTP) lives in server.ts, which is the only I/O seam in this repo.
 *
 * ## Why this exists at all
 *
 * electron-updater's GitHub provider treats GitHub's "latest" release as the
 * feed. The public extension repo publishes vsix-only tags between desktop
 * builds; those become "latest" and would stall every installed app until the
 * next desktop release. The relay therefore picks the newest non-draft release
 * that actually carries the channel's installer assets and serves that
 * release's electron-builder yml, with relative `url`/`path` values rewritten
 * to absolute GitHub download URLs so the client fetches binaries from
 * GitHub's CDN, not from us.
 *
 * A one-arch `latest-mac.yml` is a failed build (electron-builder #5592), not
 * a feed. Skip it and keep looking.
 */

import { type ReleaseAssetLike, type ReleaseLike } from "./downloads.js";

export type UpdateChannel = "win" | "mac";

/** Channel file electron-builder emits and the desktop-release workflow uploads. */
export const UPDATE_YML_NAME: Record<UpdateChannel, string> = {
  win: "latest.yml",
  mac: "latest-mac.yml",
};

/** Absolute prefix electron-updater must see in rewritten `url` / `path`. */
export const GITHUB_RELEASE_DOWNLOAD =
  "https://github.com/phuryn/grok-build-vscode/releases/download";

/**
 * Artifacts the channel's yml (and the release) must carry. Windows updates
 * from the NSIS installer; Squirrel.Mac updates from the zip, not the dmg.
 * Suffixes are anchored with `endsWith`, so a `.blockmap` does not match.
 */
export const UPDATE_REQUIRED_SUFFIXES: Record<UpdateChannel, readonly string[]> = {
  win: ["-win-x64.exe"],
  mac: ["-mac-arm64.zip", "-mac-x64.zip"],
};

const FEED_PATHS: Record<string, UpdateChannel> = {
  "/update/win/latest.yml": "win",
  "/update/mac/latest-mac.yml": "mac",
};

/** Upper bound on yml fetches per refresh so a prune-miss cannot pin the in-flight lock. */
export const UPDATE_FEED_MAX_CANDIDATES = 5;

export interface UpdateYmlCandidate {
  tag: string;
  /** Constructed GitHub download URL for the channel file. */
  url: string;
  /** Filenames attached to this release — post-rewrite existence check. */
  assets: readonly string[];
}

/** `/update/win/latest.yml` | `/update/mac/latest-mac.yml` → channel, else null. */
export function updateFeedFromPath(pathname: string): UpdateChannel | null {
  return Object.prototype.hasOwnProperty.call(FEED_PATHS, pathname) ? FEED_PATHS[pathname] : null;
}

/**
 * Newest-first candidates: non-draft releases that carry the channel yml AND
 * every required installer. Ordering is the list's own order (GitHub returns
 * newest first), matching `resolveDownload`. Pre-releases count.
 *
 * The yml body is not inspected here — a release can attach both zips and
 * still emit a one-arch yml; `rewriteUpdateYml` rejects that after the fetch.
 */
export function updateYmlCandidates(
  releases: readonly ReleaseLike[] | null | undefined,
  channel: UpdateChannel,
): UpdateYmlCandidate[] {
  if (!Array.isArray(releases)) return [];
  const ymlName = UPDATE_YML_NAME[channel];
  const suffixes = UPDATE_REQUIRED_SUFFIXES[channel];
  const out: UpdateYmlCandidate[] = [];
  for (const release of releases) {
    if (!release || release.draft) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (!isSafeReleaseTag(tag)) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!suffixes.every((s) => hasAssetEnding(assets, s))) continue;
    if (!hasAssetNamed(assets, ymlName)) continue;
    out.push({
      tag,
      url: `${GITHUB_RELEASE_DOWNLOAD}/${tag}/${ymlName}`,
      assets: assetNamesOf(assets),
    });
  }
  return out;
}

/**
 * Rewrite relative `url:` / `path:` values to absolute GitHub download URLs.
 * Everything else — `sha512`, `size`, `version`, `releaseDate`, comments,
 * quoting, line endings — is left byte-for-byte.
 *
 * The rewriter is line-oriented, not YAML-aware: a releaseNotes block line
 * matching url:/path: would be examined; the asset-name + GitHub-URL
 * validation is what bounds that.
 *
 * Returns null when the body is empty, looks like HTML, does not list
 * every artifact the channel requires (a one-arch mac yml is not a feed),
 * or any url:/path: is an absolute http(s) URL outside GITHUB_RELEASE_DOWNLOAD.
 */
export function rewriteUpdateYml(
  yml: string | null | undefined,
  tag: string,
  channel: UpdateChannel,
): string | null {
  if (typeof yml !== "string" || !yml.trim()) return null;
  if (!isSafeReleaseTag(tag)) return null;
  if (looksLikeHtml(yml)) return null;

  const nl = yml.includes("\r\n") ? "\r\n" : "\n";
  const lines: string[] = [];
  for (const line of yml.split(/\r?\n/)) {
    const next = rewriteUrlOrPathLine(line, tag);
    if (next == null) return null;
    lines.push(next);
  }
  const rewritten = lines.join(nl);
  return ymlListsRequiredArtifacts(rewritten, channel) ? rewritten : null;
}

/**
 * After rewrite, every `url:` / `path:` filename must exist on that release.
 * A stale yml uploaded onto a newer tag rewrites to URLs that 404 — reject
 * and let the caller walk the next candidate.
 */
export function ymlReferencesKnownAssets(
  yml: string,
  assetNames: readonly string[],
): boolean {
  const known = new Set(assetNames);
  let saw = false;
  for (const line of yml.split(/\r?\n/)) {
    const m = URL_OR_PATH_LINE.exec(line);
    if (!m) continue;
    const parsed = splitYamlScalar(m[4]);
    if (!parsed) continue;
    const name = filenameFromUrlOrPathValue(parsed.value);
    if (!name || !known.has(name)) return false;
    saw = true;
  }
  return saw;
}

export function isSafeReleaseTag(tag: string): boolean {
  // GitHub tags we publish are `vX.Y.Z` / prerelease variants. Reject anything
  // that could escape the download URL path.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag);
}

function hasAssetNamed(assets: readonly ReleaseAssetLike[], name: string): boolean {
  return assets.some((a) => typeof a?.name === "string" && a.name === name);
}

function hasAssetEnding(assets: readonly ReleaseAssetLike[], suffix: string): boolean {
  return assets.some((a) => typeof a?.name === "string" && a.name.endsWith(suffix));
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 256);
  return /^\s*</.test(head) || /<html[\s>]/i.test(head) || /<!doctype html/i.test(head);
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isAllowedGithubDownloadUrl(value: string): boolean {
  return value === GITHUB_RELEASE_DOWNLOAD || value.startsWith(`${GITHUB_RELEASE_DOWNLOAD}/`);
}

function assetNamesOf(assets: readonly ReleaseAssetLike[]): string[] {
  const names: string[] = [];
  for (const a of assets) {
    if (typeof a?.name === "string" && a.name) names.push(a.name);
  }
  return names;
}

function filenameFromUrlOrPathValue(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (isAbsoluteHttpUrl(v)) {
    const cut = v.split(/[?#]/, 1)[0];
    const slash = cut.lastIndexOf("/");
    if (slash < 0 || slash === cut.length - 1) return null;
    return cut.slice(slash + 1);
  }
  return v;
}

/** Single path segment: the builder's artifactName, never a URL or traversal. */
function isSafeArtifactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);
}

const URL_OR_PATH_LINE = /^([ \t]*(?:-[ \t]+)?)(url|path):([ \t]*)(.*)$/;

function rewriteUrlOrPathLine(line: string, tag: string): string | null {
  const m = URL_OR_PATH_LINE.exec(line);
  if (!m) return line;
  const [, prefix, key, space, rest] = m;
  const parsed = splitYamlScalar(rest);
  if (!parsed) return line;
  const name = parsed.value.trim();
  if (!name) return line;
  if (isAbsoluteHttpUrl(name)) {
    return isAllowedGithubDownloadUrl(name) ? line : null;
  }
  if (!isSafeArtifactName(name)) return line;
  return `${prefix}${key}:${space}${parsed.quote}${GITHUB_RELEASE_DOWNLOAD}/${tag}/${name}${parsed.quote}${parsed.suffix}`;
}

/** Pull a quoted or unquoted YAML scalar off the remainder of a `key: value` line. */
function splitYamlScalar(
  rest: string,
): { quote: string; value: string; suffix: string } | null {
  if (rest.startsWith("'") || rest.startsWith('"')) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end < 0) return null;
    return { quote, value: rest.slice(1, end), suffix: rest.slice(end + 1) };
  }
  const comment = /[ \t]+#/.exec(rest);
  if (comment) {
    return { quote: "", value: rest.slice(0, comment.index), suffix: rest.slice(comment.index) };
  }
  return { quote: "", value: rest, suffix: "" };
}

function ymlListsRequiredArtifacts(yml: string, channel: UpdateChannel): boolean {
  return UPDATE_REQUIRED_SUFFIXES[channel].every((suffix) => ymlListsSuffix(yml, suffix));
}

function ymlListsSuffix(yml: string, suffix: string): boolean {
  for (const line of yml.split(/\r?\n/)) {
    const m = URL_OR_PATH_LINE.exec(line);
    if (!m) continue;
    const parsed = splitYamlScalar(m[4]);
    if (!parsed) continue;
    const value = parsed.value.trim();
    if (value.endsWith(suffix)) return true;
  }
  return false;
}
