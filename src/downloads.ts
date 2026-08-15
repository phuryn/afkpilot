/**
 * Resolving `/download/<platform>` to the current desktop installer.
 *
 * Pure — no network, no fs. The impure half (one fetch, cached) lives in
 * server.ts, which is the only I/O seam in this repo.
 *
 * ## Why this exists at all
 *
 * The download page used to resolve installers **in the visitor's browser**, by
 * calling the GitHub API from the page. That is 60 requests an hour per IP,
 * unauthenticated — so a handful of people behind one office NAT exhaust it and
 * the page tells all of them "downloads unavailable right now", which is a lie
 * about our releases rather than a fact about their network. Resolving here
 * costs one request per cache window for everybody.
 *
 * The binaries stay on GitHub. Release assets on a public repo are free and
 * CDN-served, while this relay pays for egress and rebuilds its image on every
 * deploy — so these endpoints REDIRECT and never proxy. The user sees an
 * afkpilot.com URL and never a wall of `.blockmap` files; we serve no bytes.
 */

/** Stable URL segment → the suffix its installer asset ends with. */
export const DOWNLOAD_PLATFORMS: Record<string, string> = {
  "win-x64": "-win-x64.exe",
  "mac-arm64": "-mac-arm64.dmg",
  "mac-x64": "-mac-x64.dmg",
};

export const RELEASES_PAGE_URL = "https://github.com/phuryn/grok-build-vscode/releases/latest";

export interface ReleaseAssetLike {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

export interface ReleaseLike {
  tag_name?: string;
  draft?: boolean;
  assets?: ReleaseAssetLike[] | null;
}

export interface ResolvedDownload {
  url: string;
  version: string;
  size: number;
}

/**
 * The newest published release carrying desktop installers, and that release's
 * asset for `platform`.
 *
 * Newest-with-installers, not simply newest: a release that ships only the
 * `.vsix` is an extension-only patch and must not blank the desktop downloads.
 * Drafts are skipped — their assets 404 for anonymous callers, so offering one
 * is worse than offering the previous version. Pre-releases COUNT, for the same
 * reason the in-app update check counts them: the desktop app ships that way
 * while it is unsigned.
 *
 * Ordering is by the release list's own order (GitHub returns newest first)
 * rather than by parsing versions, so a hand-made tag cannot reorder history.
 */
export function resolveDownload(
  releases: readonly ReleaseLike[] | null | undefined,
  platform: string,
): ResolvedDownload | null {
  const suffix = DOWNLOAD_PLATFORMS[platform];
  if (!suffix || !Array.isArray(releases)) return null;
  for (const release of releases) {
    if (!release || release.draft) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    // "Carries installers" is judged across ALL platforms, so a release whose
    // macOS job failed does not silently become the answer for Windows while
    // Mac visitors fall through to an older one. Either the set is current or
    // this release is not the current one.
    const complete = Object.values(DOWNLOAD_PLATFORMS).every((s) =>
      assets.some((a: ReleaseAssetLike) => typeof a?.name === "string" && a.name.endsWith(s)),
    );
    if (!complete) continue;
    const hit = assets.find((a: ReleaseAssetLike) => typeof a?.name === "string" && a.name.endsWith(suffix));
    if (!hit?.browser_download_url) continue;
    return {
      url: hit.browser_download_url,
      version: String(release.tag_name || "").replace(/^v/, ""),
      size: Number(hit.size) || 0,
    };
  }
  return null;
}

/** `/download/<platform>` → the platform, or null when the path is not one. */
export function downloadPlatformFromPath(pathname: string): string | null {
  const m = /^\/download\/([a-z0-9-]{1,32})$/.exec(pathname);
  if (!m) return null;
  return Object.prototype.hasOwnProperty.call(DOWNLOAD_PLATFORMS, m[1]) ? m[1] : null;
}
