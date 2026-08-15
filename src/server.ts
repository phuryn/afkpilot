// Relay server assembly — the impure edge over the pure LinkStore/DeviceRegistry/Hub.
//
//   REST : /api/link/start | /api/link/info | /api/link/approve | /api/link/poll
//          /api/devices | /api/device/unlink
//          /download/<platform>                 (302 to the current GitHub installer)
//          /update/win/latest.yml               (electron-updater, public)
//          /update/mac/latest-mac.yml
//   WS   : /uplink?token=…   (the extension, authenticated by device token)
//          /client?device=…  (browsers; session-authenticated + device ownership)
//   Pages: /  /desktop  /link  /chat  + /vendor/* static assets (synced extension UI)
//
// Auth: REST /api/link/approve + /api/devices and the /client upgrade require a
// verified session (Bearer or __session cookie -> SessionVerifier) and, when a
// feature is configured, the entitlement. /uplink stays session-free by design:
// the device token IS the credential there and the enforcement point is /client.
//
// The relay is deliberately policy-free: capability gating lives in the
// extension (its remote-policy module), so a compromised relay can inject
// messages but the extension still refuses host-local ones. Payloads are
// ferried, never persisted.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { LinkStore } from "./link-store.js";
import { type DeviceRecord, type DeviceRegistry } from "./devices.js";
import { entitled, sessionTokenFromRequest, type SessionVerifier } from "./auth.js";
import { hasDeviceClientInfo, parseDeviceClientFields } from "./device-client.js";
import { countMachines, isRecognizedInstallId, MinuteRateLimiter, type FreeTier, type MessageRate } from "./limits.js";
import { usageWindow, resetsInText } from "./usage.js";
import { Hub } from "./hub.js";
import { parseUplinkFrame, REMOTE_PROTO_VERSION } from "./frames.js";
import { downloadPlatformFromPath, resolveDownload, RELEASES_PAGE_URL } from "./downloads.js";
import {
  rewriteUpdateYml,
  UPDATE_FEED_MAX_CANDIDATES,
  updateFeedFromPath,
  updateYmlCandidates,
  ymlReferencesKnownAssets,
  type UpdateChannel,
} from "./update-feed.js";

export interface RelayServerOptions {
  host: string;
  port: number;
  /** Directory holding the web pages + vendor assets (the repo's web/). */
  webRoot: string;
  store: LinkStore;
  devices: DeviceRegistry;
  /** Verifies session tokens (Clerk in prod, mock in dev). */
  sessions: SessionVerifier;
  /** Clerk Billing feature a session must carry; undefined = open gate. */
  requiredFeature: string | undefined;
  /** Caps for signed-in users WITHOUT the feature: device limit at approve,
   *  weekly prompt quota at /client. undefined = hard gate (403/4005 for
   *  unentitled). Only consulted when requiredFeature is set. */
  freeTier?: FreeTier;
  /** Per-minute `send` burst cap for ALL users (abuse guard, paid included).
   *  undefined = no cap. */
  messageRate?: MessageRate;
  /** Transport ceiling for PCM chunks. Defaults to the production-safe value;
   *  injectable so integration tests can exercise the boundary cheaply. */
  voiceChunkRate?: MessageRate;
  /** Clerk publishable key handed to browsers via /api/config; undefined =
   *  mock mode (pages skip ClerkJS and behave as before auth existed). */
  clerkPublishableKey?: string;
  /** WS heartbeat period. Proxies kill idle WebSockets (Cloudflare: ~100s
   *  without traffic), and our uplink is idle whenever nobody is chatting —
   *  server pings keep both edges alive (peers auto-pong; browsers can't send
   *  pings themselves) and reap half-dead sockets that missed a pong. Default
   *  30s; 0 disables (tests). */
  pingIntervalMs?: number;
  hub: Hub;
  log: (line: string) => void;
  /**
   * GitHub HTTP (releases API + channel-file bytes). Tests inject a stub so
   * the feed endpoints never depend on the network or the rate limit.
   */
  githubFetch?: typeof fetch;
  /**
   * Cache window for the releases list and the rewritten update yml. Default
   * ten minutes — same rationale as the download resolver. Tests shrink it
   * so expiry can be exercised without waiting.
   */
  releasesTtlMs?: number;
  /**
   * How long the update feed answers 503 without re-walking GitHub after a
   * failed refresh. Default one minute. Tests shrink it.
   */
  feedFailBackoffMs?: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Top-level web/ files served directly (everything else is pages/vendor). */
const STATIC_FILES = new Set([
  "auth.js",
  "device-display.js",
  "host-version.js",
  "theme.css",
  "logo.svg",
  "favicon.svg",
  "robots.txt",
  "sitemap.xml",
  "og-home.png",
  "og-desktop.png",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
  "manifest.webmanifest",
  "hero-phone.png",
  "desktop-app.webp",
]);

const PAGES: Record<string, string> = {
  "/": "index.html",
  "/desktop": "desktop.html",
  "/desktop-update": "desktop-update.html",
  "/link": "link.html",
  "/chat": "chat.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
};

const MAX_BODY_BYTES = 1024 * 1024;

// The wire also carries 20 MiB browser uploads and host media capped at
// 25 MiB decoded. 36 MiB covers the latter's base64 expansion plus its JSON
// envelope, replacing ws's overly broad 100 MiB default without regressing
// those established frame types.
export const MAX_WS_PAYLOAD_BYTES = 36 * 1024 * 1024;
export const MAX_AUTH_PENDING_FRAMES = 32;
// Before admission, legitimate peers only send small control frames (`ready`
// or `hello`, plus at most a short restore burst). A 64 KiB aggregate budget
// leaves ample headroom for those while preventing one unauthenticated socket
// from retaining a media-sized transport frame during network-bound checks.
export const MAX_AUTH_PENDING_BYTES = 64 * 1024;

// The extension accepts at most 256 KiB decoded PCM per chunk (~342 KiB
// base64). Keep enough JSON/headroom for that contract while rejecting an
// audio-shaped frame well before it is wrapped and serialized to the uplink.
export const MAX_REMOTE_VOICE_FRAME_BYTES = 512 * 1024;
// A capture tab emits about 469 chunks/minute (2,048 samples at 16 kHz).
// Budget two simultaneous tabs per device with comparable headroom, while
// keeping the ceiling fixed regardless of reconnects or additional tabs.
export const MAX_REMOTE_VOICE_CHUNKS_PER_MINUTE = 1200;

/** Close code the extension's uplink treats as "re-link, don't retry". Keep in
 *  sync with remote-uplink.ts in the extension repo. */
export const CLOSE_BAD_TOKEN = 4001;
/** /client: no verified session on the upgrade. */
export const CLOSE_AUTH_REQUIRED = 4004;
/** /client: session verified but lacks the required entitlement. */
export const CLOSE_ENTITLEMENT_REQUIRED = 4005;
/** /uplink: the peer violated or is newer than this relay's wire contract. */
export const CLOSE_PROTOCOL_ERROR = 4006;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface RelayServer {
  server: http.Server;
  /** The actually-bound port (options.port 0 = ephemeral, for tests). */
  port: () => number;
  close: () => Promise<void>;
}

/** Shape sessionTokenFromRequest reads off an incoming request/upgrade. */
const authHeaders = (req: http.IncomingMessage) => ({
  authorization: req.headers.authorization,
  cookie: req.headers.cookie,
});

/** A per-deploy token stamped onto vendored asset URLs in the served HTML. Our
 *  origin sends `cache-control: no-cache`, but Cloudflare's Browser Cache TTL
 *  rewrites that to hours on static .js/.css — so a UI deploy silently kept
 *  serving the old bundle. Changing the URL (query string) is what actually
 *  forces the browser and Cloudflare to refetch: a new deploy = a new `?v=`.
 *  Commit SHA when the host provides one (Railway), else a content hash of
 *  every file reachable through the page/static/vendor routes. Hash paths as
 *  well as bytes so adding, removing, or renaming a browser artifact moves the
 *  token too. Dynamic API responses are not deploy artifacts. */
export function computeAssetVersion(
  webRoot: string,
  deploySha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "",
): string {
  const sha = deploySha.trim();
  if (sha) return sha.slice(0, 12);
  try {
    const rels = [
      ...Object.values(PAGES),
      ...STATIC_FILES,
    ];
    const vendorRoot = path.join(webRoot, "vendor");
    const collectVendor = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) collectVendor(path.join(dir, entry.name), rel);
        else if (entry.isFile()) rels.push(rel);
      }
    };
    try {
      collectVendor(vendorRoot, "vendor");
    } catch {
      /* vendor may be absent in small test roots */
    }

    const h = crypto.createHash("sha1");
    let files = 0;
    for (const rel of [...new Set(rels)].sort()) {
      try {
        h.update(rel);
        h.update("\0");
        h.update(fs.readFileSync(path.join(webRoot, rel)));
        h.update("\0");
        files++;
      } catch {
        /* absent in some test roots */
      }
    }
    return files ? h.digest("hex").slice(0, 12) : "dev";
  } catch {
    return "dev";
  }
}

/** Append `?v=<version>` to same-origin, deploy-coupled asset refs (the vendored
 *  UI + auth.js/device-display.js/theme.css/host-version.js) in an HTML page. Scoped to script/link
 *  `src`/`href` targets under /vendor/media or the top-level page scripts; page
 *  links, images, the manifest, and anything already carrying a query are left
 *  untouched. */
export function versionAssets(html: string, v: string): string {
  return html.replace(
    /((?:src|href)=")(\/(?:vendor\/media\/[^"?]+|auth\.js|device-display\.js|theme\.css|host-version\.js))(")/g,
    (_m, pre: string, target: string, post: string) => `${pre}${target}?v=${v}${post}`,
  );
}

/**
 * The version the browser client reports as its own — the extension release the
 * vendored UI was cut from, recorded by `npm run sync-ui`. Falls back to the
 * deploy's asset hash, which is at least unique per deploy.
 *
 * Not the relay's own package version: that number has never moved and says
 * nothing about the UI a phone is actually running.
 */
export function readWebAppVersion(webRoot: string, fallback: string): string {
  try {
    const raw = fs.readFileSync(
      path.join(webRoot, "vendor", "ui-vendor-manifest.json"),
      "utf8",
    );
    const v = (JSON.parse(raw) as { source?: { appVersion?: unknown } }).source?.appVersion;
    return typeof v === "string" && v ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Hand the page its own version as a meta tag. A meta rather than a fetch so the
 * About panel can answer instantly and offline, and rewritten on the way out for
 * the same reason `versionAssets` is: the file on disk must stay a file anyone
 * can open, not a template with a placeholder in it.
 */
export function injectWebAppVersion(html: string, version: string): string {
  const tag = `<meta name="grok-web-version" content="${version.replace(/[^\w.\-+]/g, "")}">`;
  return html.includes("<head>") ? html.replace("<head>", `<head>\n  ${tag}`) : html;
}

export function createRelayServer(opts: RelayServerOptions): RelayServer {
  const { store, devices, sessions, requiredFeature, freeTier, messageRate, hub, log } = opts;

  // Computed once at boot — a fresh process is a fresh deploy.
  const assetVersion = computeAssetVersion(opts.webRoot);
  const webAppVersion = readWebAppVersion(opts.webRoot, assetVersion);

  // Live uplink sockets by deviceId — lets DELETE /api/devices/{id} terminate
  // the extension's connection the moment its token is revoked.
  const uplinkSockets = new Map<string, WebSocket>();

  async function revokeDevice(deviceId: string): Promise<void> {
    await devices.revoke(deviceId);
    const live = uplinkSockets.get(deviceId);
    if (live) {
      try {
        live.close(CLOSE_BAD_TOKEN, "device removed");
      } catch {
        /* already down */
      }
    }
  }

  /** Device token already proved identity — write only client metadata. */
  function backfillDeviceClient(device: DeviceRecord, raw: string): void {
    const frame = parseUplinkFrame(raw);
    if (frame?.t !== "hello" || !hasDeviceClientInfo(frame.client)) return;
    const incoming = frame.client!;
    const same =
      (incoming.clientLabel === undefined || incoming.clientLabel === device.clientLabel) &&
      (incoming.platform === undefined || incoming.platform === device.platform) &&
      (incoming.osLabel === undefined || incoming.osLabel === device.osLabel);
    if (same) return;
    if (incoming.clientLabel !== undefined) device.clientLabel = incoming.clientLabel;
    if (incoming.platform !== undefined) device.platform = incoming.platform;
    if (incoming.osLabel !== undefined) device.osLabel = incoming.osLabel;
    void devices.updateClient(device.deviceId, incoming).catch((e) => {
      log(`[relay] device client backfill failed: ${(e as Error).message}`);
    });
  }

  // One GitHub call per window for the whole deployment, shared by every
  // visitor. Ten minutes is chosen against how often releases actually happen
  // (rarely) versus how long a fresh one may look absent (at most this): the
  // anonymous rate limit is 60/hour, so even a cold cache thrashing cannot
  // approach it. The cache is deliberately not invalidated on release — nothing
  // here knows when one lands, and inventing a webhook to save ten minutes is
  // machinery to maintain forever.
  const RELEASES_URL = "https://api.github.com/repos/phuryn/grok-build-vscode/releases?per_page=100";
  const RELEASES_TTL_MS = opts.releasesTtlMs ?? 10 * 60 * 1000;
  const githubFetch = opts.githubFetch ?? fetch;
  let releasesCache: { at: number; value: unknown } | null = null;
  let releasesInFlight: Promise<unknown> | null = null;

  // GitHub authenticates by token when the operator provides one. Railway's
  // egress IP is SHARED across tenants, so the anonymous 60/hr limit can be
  // exhausted by strangers — observed in production on 2026-08-14 (/download
  // falling back to the releases page, the update feed answering 503). A
  // fine-grained public-read token moves the quota to 5000/hr per token.
  // Optional by design: keyless dev keeps working, headers just stay anonymous.
  function githubHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = { accept, "user-agent": "afkpilot-relay" };
    const token = (process.env.GITHUB_TOKEN || "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async function cachedReleases(): Promise<unknown> {
    const now = Date.now();
    if (releasesCache && now - releasesCache.at < RELEASES_TTL_MS) return releasesCache.value;
    // Share one request across concurrent misses — a burst after a deploy would
    // otherwise open a dozen at once for the same answer.
    if (releasesInFlight) return releasesInFlight;
    releasesInFlight = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await githubFetch(RELEASES_URL, {
          headers: githubHeaders("application/vnd.github+json"),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`github ${r.status}`);
        const body: unknown = await r.json();
        releasesCache = { at: Date.now(), value: body };
        return body;
      } catch (e) {
        opts.log(`[downloads] release lookup failed: ${(e as Error)?.message ?? e}`);
        // Serve a stale answer over none: an installer URL from ten minutes ago
        // is still a working download, and the alternative is sending everyone
        // to the releases page because GitHub blipped.
        return releasesCache?.value ?? null;
      } finally {
        releasesInFlight = null;
      }
    })();
    return releasesInFlight;
  }

  // Rewritten electron-updater channel files. Deliberately NO stale-serve:
  // four review rounds showed that keeping a "last good" copy alive through
  // partial failures needs provenance machinery to avoid either defeating an
  // operator yank (serving a pulled yml) or wiping a valid feed — and the
  // availability it buys is ~nil (clients check every 12 h and treat 404 and
  // 503 identically: silent fallback to the notice path). So: one cache entry
  // per channel, positive (200) or negative (404), served while younger than
  // the TTL. Beyond it a refresh either replaces the entry or the client gets
  // the real failure status — nothing yanked outlives one TTL. A short
  // failure stamp keeps a GitHub outage from turning every GET into a walk.
  const MAX_YML_BYTES = 64 * 1024;
  const FEED_FAIL_BACKOFF_MS = opts.feedFailBackoffMs ?? 60 * 1000;
  type FeedCacheEntry = { at: number; body: string | null };
  const feedCache: Record<UpdateChannel, FeedCacheEntry | null> = { win: null, mac: null };
  const feedFailAt: Record<UpdateChannel, number> = { win: 0, mac: 0 };
  const feedInFlight: Record<UpdateChannel, Promise<string | null> | null> = {
    win: null,
    mac: null,
  };

  async function fetchGithubText(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await githubFetch(url, {
        headers: githubHeaders("application/octet-stream"),
        signal: controller.signal,
      });
      if (r.status === 404 || r.status === 410) return null;
      if (!r.ok) throw new Error(`github ${r.status}`);
      const cl = r.headers.get("content-length");
      if (cl != null) {
        const n = Number(cl);
        if (Number.isFinite(n) && n > MAX_YML_BYTES) {
          try {
            void r.body?.cancel();
          } catch {
            /* ignore */
          }
          throw new Error("yml too large");
        }
      }
      const text = await r.text();
      if (text.length > MAX_YML_BYTES) throw new Error("yml too large");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshUpdateFeed(channel: UpdateChannel): Promise<string | null> {
    const releases = await cachedReleases();
    if (releases == null) throw new Error("github unavailable");
    if (!Array.isArray(releases)) throw new Error("github malformed");
    const candidates = updateYmlCandidates(releases, channel).slice(0, UPDATE_FEED_MAX_CANDIDATES);
    // A candidate that definitively is not a feed (yml 404/410, rewrite
    // reject, unknown-asset reject) falls through to the next. A transport
    // failure (503, timeout, oversized) is remembered; if the walk ends with
    // no body it throws, because "nothing publishable" was not actually
    // established — the caller answers 503 and retries after the backoff
    // rather than caching an answer that might be wrong in either direction.
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        const raw = await fetchGithubText(candidate.url);
        if (raw == null) continue;
        const rewritten = rewriteUpdateYml(raw, candidate.tag, channel);
        if (!rewritten || !ymlReferencesKnownAssets(rewritten, candidate.assets)) continue;
        return rewritten;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async function loadUpdateFeed(channel: UpdateChannel): Promise<{ status: number; body: string; type: string }> {
    const now = Date.now();
    const hit = feedCache[channel];
    if (hit && now - hit.at < RELEASES_TTL_MS) {
      if (hit.body != null) {
        return { status: 200, body: hit.body, type: "application/x-yaml; charset=utf-8" };
      }
      return { status: 404, body: "not found", type: "text/plain; charset=utf-8" };
    }
    if (now - feedFailAt[channel] < FEED_FAIL_BACKOFF_MS) {
      return { status: 503, body: "unavailable", type: "text/plain; charset=utf-8" };
    }
    let pending = feedInFlight[channel];
    if (!pending) {
      pending = refreshUpdateFeed(channel).finally(() => {
        if (feedInFlight[channel] === pending) feedInFlight[channel] = null;
      });
      feedInFlight[channel] = pending;
    }
    try {
      const fresh = await pending;
      feedCache[channel] = { at: Date.now(), body: fresh };
      // A success clears the failure stamp; without this, a shrunken test TTL
      // (or any future TTL < backoff) could 503 past a live refresh.
      feedFailAt[channel] = 0;
      if (fresh != null) {
        return { status: 200, body: fresh, type: "application/x-yaml; charset=utf-8" };
      }
      return { status: 404, body: "not found", type: "text/plain; charset=utf-8" };
    } catch (e) {
      log(`[update-feed] ${channel} refresh failed: ${(e as Error)?.message ?? e}`);
      feedFailAt[channel] = Date.now();
      return { status: 503, body: "unavailable", type: "text/plain; charset=utf-8" };
    }
  }

  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://relay");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/health") {
        // Liveness for the hosting platform's checks. No dependencies probed —
        // a db/Clerk blip must not make the orchestrator restart the relay.
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/config") {
        // Open by design: the publishable key is browser-safe and the pages
        // need it before any session exists. null key = mock mode.
        return sendJson(res, 200, {
          publishableKey: opts.clerkPublishableKey ?? null,
          requiredFeature: requiredFeature ?? null,
        });
      }
      if (req.method === "POST" && p === "/api/link/start") {
        const body = await readJsonBody(req);
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "Unnamed device";
        // Opaque per-install id from the extension; absent on older builds, which
        // simply never dedupe. Never displayed, never persisted beyond the device row.
        // Truncate BEFORE validating, so the property we check is the property
        // the device row actually stores: validating first would accept a long
        // `<250 chars>:desktop` and then persist it with the sanctioned suffix
        // sliced off.
        const rawInstallId = typeof body?.installId === "string" ? body.installId.trim().slice(0, 200) : "";
        if (rawInstallId && !isRecognizedInstallId(rawInstallId)) {
          return sendJson(res, 400, { ok: false, error: "install-id" });
        }
        const installId = rawInstallId || undefined;
        const parsedClient = parseDeviceClientFields(body);
        if (!parsedClient.ok) return sendJson(res, 400, { ok: false, error: "client" });
        const client = hasDeviceClientInfo(parsedClient.client) ? parsedClient.client : undefined;
        return sendJson(res, 200, store.start(name, installId, client));
      }
      if (req.method === "GET" && p === "/api/link/info") {
        return sendJson(res, 200, store.info(url.searchParams.get("code") ?? ""));
      }
      if (req.method === "POST" && p === "/api/link/approve") {
        // Requires a verified session; the issued device is scoped to that
        // user's account. Unentitled users pass on the free tier (device cap)
        // when one is configured, else hit the hard gate.
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        // Resolve the link BEFORE the cap check: the pending record carries the
        // install id, and a re-link must be able to retire its own predecessor
        // before we count what the account owns.
        const body = await readJsonBody(req);
        const code = typeof body?.code === "string" ? body.code : "";
        const info = store.info(code);
        if (info.status !== "pending") return sendJson(res, 400, { ok: false, status: info.status });
        // Re-linking a machine that is ALREADY linked used to mint a second
        // device and then bounce the user off the free tier's device cap — a
        // paywall for hardware they already owned, hit precisely when they were
        // recovering from a reinstall or a failed connection. The device name is
        // a hostname label and cannot carry identity, so we key on the
        // extension's anonymous per-install id and supersede the old row.
        // Revoke (not update) so the old token dies with it: whatever is holding
        // that token is by definition a stale uplink for this same machine.
        if (info.installId) {
          const superseded = (await devices.listByUser(claims.userId)).filter(
            (d) => d.installId === info.installId,
          );
          for (const d of superseded) {
            await devices.revoke(d.deviceId);
            log(`[relay] re-link supersedes device ${d.deviceId} (user ${claims.userId})`);
          }
        }
        if (!entitled(claims, requiredFeature)) {
          if (!freeTier) return sendJson(res, 403, { ok: false, error: "entitlement" });
          const ownedDevices = await devices.listByUser(claims.userId);
          const owned = countMachines([...ownedDevices, { installId: info.installId }]);
          if (owned > freeTier.devices) {
            return sendJson(res, 403, { ok: false, error: "entitlement", reason: "device-limit", limit: freeTier.devices });
          }
        }
        const issued = await devices.issue(info.deviceName ?? "Unnamed device", claims.userId, info.installId, {
          clientLabel: info.clientLabel,
          platform: info.platform,
          osLabel: info.osLabel,
        });
        store.approve(code, issued.token);
        log(`[relay] link ${code} approved -> device ${issued.deviceId} (user ${claims.userId})`);
        return sendJson(res, 200, { ok: true, deviceId: issued.deviceId });
      }
      if (req.method === "POST" && p === "/api/link/poll") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, store.poll(typeof body?.code === "string" ? body.code : ""));
      }
      if (req.method === "GET" && p === "/api/devices") {
        // ALL the caller's devices — offline ones included, so the device
        // manager can show and remove them. Liveness/viewers from the hub.
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        const list = (await devices.listByUser(claims.userId))
          .map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            createdAt: d.createdAt,
            online: hub.uplinkConnected(d.deviceId),
            clients: hub.clientCount(d.deviceId),
            clientLabel: d.clientLabel ?? null,
            platform: d.platform ?? null,
            osLabel: d.osLabel ?? null,
          }));
        return sendJson(res, 200, { devices: list });
      }
      if (req.method === "DELETE" && p.startsWith("/api/devices/")) {
        // Remove a device: owner-checked revoke; a live uplink is closed with
        // the re-link code (its token is dead — retrying would be useless).
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        const deviceId = decodeURIComponent(p.slice("/api/devices/".length));
        const owned = (await devices.findOwned(deviceId, claims.userId)) !== null;
        if (!owned) return sendJson(res, 404, { ok: false, error: "unknown" });
        await revokeDevice(deviceId);
        log(`[relay] device ${deviceId} removed by ${claims.userId}`);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/device/unlink") {
        // The extension calls this on local sign-out so its server row stops
        // counting against the free device cap and a later relink can succeed.
        const token = sessionTokenFromRequest({ authorization: req.headers.authorization });
        const device = await devices.verify(token);
        if (!device) return sendJson(res, 401, { ok: false, error: "token" });
        await revokeDevice(device.deviceId);
        log(`[relay] device ${device.deviceId} unlinked by device token`);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/me") {
        // The signed-in user's plan surface: entitlement + free-tier usage —
        // what the landing's usage meter renders.
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        const isEntitled = entitled(claims, requiredFeature);
        let limits: Record<string, unknown> | null = null;
        if (!isEntitled && freeTier) {
          const win = usageWindow(Date.now());
          let used = 0;
          try {
            // Clamped: blocked attempts still increment the stored count
            // (atomic increment-then-check), but the meter shows at most the
            // cap — "5 / 2" would read like a bug.
            used = Math.min(await freeTier.usage.peek(claims.userId, win.start), freeTier.weeklyMsgs);
          } catch {
            /* usage store down — the meter shows 0 rather than erroring */
          }
          limits = {
            weeklyMsgs: freeTier.weeklyMsgs,
            used,
            devices: freeTier.devices,
            maxPerMinute: messageRate?.perMinute ?? null,
            resetsAt: new Date(win.resetsAt).toISOString(),
          };
        }
        return sendJson(res, 200, { userId: claims.userId, entitled: isEntitled, limits });
      }
      // /download/<platform> — one redirect to the current installer on GitHub.
      // Resolved HERE rather than in the page so a shared IP cannot exhaust the
      // anonymous GitHub rate limit and turn "we have builds" into "downloads
      // unavailable". A redirect, never a proxy: the bytes stay on GitHub's CDN,
      // which is free, while this host bills egress.
      const platform = req.method === "GET" ? downloadPlatformFromPath(p) : null;
      if (platform) {
        const releases = await cachedReleases();
        const hit = resolveDownload(Array.isArray(releases) ? releases : null, platform);
        // Upstream down, or a release mid-upload: send them to the releases page
        // rather than a dead end. One more click beats an error they cannot act
        // on, and it is still true — the build IS there.
        res.writeHead(302, {
          location: hit?.url ?? RELEASES_PAGE_URL,
          "cache-control": "no-store",
        });
        return void res.end();
      }
      // /update/win/latest.yml and /update/mac/latest-mac.yml — public
      // electron-updater channel files. Unauthenticated on purpose: they
      // carry only public release metadata. A vsix-only GitHub "latest" is
      // skipped; a one-arch mac yml is not published. Errors are real
      // statuses (never HTML-with-200) — the client treats any failure as
      // silence and falls back to the notice path.
      const feed = req.method === "GET" ? updateFeedFromPath(p) : null;
      if (feed) {
        const served = await loadUpdateFeed(feed);
        res.writeHead(served.status, {
          "content-type": served.type,
          // no-store on every status: an edge cache honoring max-age can pin
          // a yanked feed for the TTL. electron-updater already busts with
          // ?noCache; the in-process cache bounds origin work.
          "cache-control": "no-store",
        });
        return void res.end(served.body);
      }
      // pages + static
      const page = PAGES[p];
      if (req.method === "GET" && page) return servePage(res, path.join(opts.webRoot, page));
      if (req.method === "GET" && STATIC_FILES.has(p.slice(1))) return serveFile(res, path.join(opts.webRoot, p.slice(1)));
      if (req.method === "GET" && p.startsWith("/vendor/")) {
        const rel = decodeURIComponent(p.slice(1));
        if (rel.includes("..")) {
          res.writeHead(404);
          return void res.end("not found");
        }
        return serveFile(res, path.join(opts.webRoot, rel));
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      log(`[relay] http error on ${p}: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  function serveFile(res: http.ServerResponse, abs: string): void {
    fs.readFile(abs, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
        // Without a policy browsers cache heuristically, so a deployed page/JS
        // fix may not reach a phone that tested the old one. no-cache =
        // revalidate every load (304 when unchanged) — pages and the vendored
        // UI must always move in lockstep with the relay.
        "cache-control": "no-cache",
      });
      res.end(buf);
    });
  }

  // HTML pages carry `?v=<assetVersion>` on their vendored asset refs before
  // going out, so a deploy's new bundle is fetched under a new URL even when
  // Cloudflare has stamped a multi-hour Browser Cache TTL on the old one. The
  // page itself stays no-cache (it must always hand back the current version).
  function servePage(res: http.ServerResponse, abs: string): void {
    fs.readFile(abs, "utf8", (err, html) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "cache-control": "no-cache",
      });
      res.end(injectWebAppVersion(versionAssets(html, assetVersion), webAppVersion));
    });
  }

  // ---------- websocket edges ----------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const voiceChunkRate =
    opts.voiceChunkRate ?? {
      perMinute: MAX_REMOTE_VOICE_CHUNKS_PER_MINUTE,
      limiter: new MinuteRateLimiter(Date.now),
    };
  const alive = new WeakMap<WebSocket, boolean>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://relay");
    if (url.pathname === "/uplink" || url.pathname === "/client") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        alive.set(ws, true);
        ws.on("pong", () => alive.set(ws, true));
        if (url.pathname === "/uplink") void handleUplink(ws, url);
        else void handleClient(ws, url, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Heartbeat (see pingIntervalMs): ping every live socket; one missed pong
  // by the next tick = dead peer, terminate so the hub detaches and (for an
  // uplink) the extension's reconnect isn't blocked by a zombie (4002).
  const pingEvery = opts.pingIntervalMs ?? 30_000;
  const pinger =
    pingEvery > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            if (alive.get(ws) === false) {
              ws.terminate();
              continue;
            }
            alive.set(ws, false);
            try {
              ws.ping();
            } catch {
              /* teardown race */
            }
          }
        }, pingEvery)
      : undefined;

  /** The upgrade completes BEFORE our async admission checks (network calls to
   *  Clerk/Supabase in production), so the peer's first frames — the
   *  extension's `hello`, the page's `ready` — can arrive while we're still
   *  awaiting. Without a buffer they'd be silently lost (no listener yet) and
   *  the chat page hangs unsynced. Buffer until admission, then replay through
   *  the real handler. */
  function bufferUntilAdmitted(ws: WebSocket): (handler: (raw: string) => void) => void {
    const pending: string[] = [];
    let pendingBytes = 0;
    let overflowed = false;
    const buffer = (raw: unknown) => {
      if (overflowed) return;
      const text = String(raw);
      const bytes = Buffer.byteLength(text);
      if (pending.length >= MAX_AUTH_PENDING_FRAMES || pendingBytes + bytes > MAX_AUTH_PENDING_BYTES) {
        overflowed = true;
        pending.length = 0;
        pendingBytes = 0;
        ws.close(1009, "too much data pending authentication");
        return;
      }
      pending.push(text);
      pendingBytes += bytes;
    };
    ws.on("message", buffer);
    return (handler) => {
      ws.off("message", buffer);
      if (overflowed || ws.readyState !== WebSocket.OPEN) return;
      ws.on("message", (raw) => handler(String(raw)));
      for (const raw of pending) handler(raw);
    };
  }

  async function handleUplink(ws: WebSocket, url: URL): Promise<void> {
    const admit = bufferUntilAdmitted(ws);
    let device: Awaited<ReturnType<DeviceRegistry["verify"]>>;
    try {
      device = await devices.verify(url.searchParams.get("token") ?? "");
    } catch (e) {
      // Registry (db) hiccup — NOT 4001: the extension should retry, not re-link.
      log(`[relay] uplink verify failed: ${(e as Error).message}`);
      ws.close(1011, "registry error");
      return;
    }
    if (!device) {
      ws.close(CLOSE_BAD_TOKEN, "bad device token");
      return;
    }
    // The socket can die during the (possibly network-bound) verify; attaching
    // it then would strand a zombie uplink that blocks the device's reconnect.
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!hub.attachUplink(device.deviceId, ws)) {
      ws.close(4002, "device already connected");
      return;
    }
    log(`[relay] uplink attached: ${device.name} (${device.deviceId})`);
    uplinkSockets.set(device.deviceId, ws);
    admit((raw) => {
      const result = hub.fromUplink(device.deviceId, raw);
      if (result.kind === "accepted") backfillDeviceClient(device, raw);
      if (result.kind !== "refused") return;
      if (result.reason === "protocol-too-new") {
        ws.close(
          CLOSE_PROTOCOL_ERROR,
          `peer protocol ${result.peerProto} is newer than relay protocol ${REMOTE_PROTO_VERSION}`,
        );
      } else {
        ws.close(CLOSE_PROTOCOL_ERROR, "protocol hello required before host traffic");
      }
    });
    const detach = () => {
      hub.detachUplink(device.deviceId);
      if (uplinkSockets.get(device.deviceId) === ws) uplinkSockets.delete(device.deviceId);
      log(`[relay] uplink detached: ${device.deviceId}`);
    };
    ws.on("close", detach);
    ws.on("error", () => ws.close());
  }

  async function handleClient(ws: WebSocket, url: URL, req: http.IncomingMessage): Promise<void> {
    const deviceId = url.searchParams.get("device") ?? "";
    if (!deviceId) {
      ws.close(4003, "missing device id");
      return;
    }
    const admit = bufferUntilAdmitted(ws);
    // Verify the session off the upgrade headers (Bearer or __session cookie).
    let claims: Awaited<ReturnType<SessionVerifier["verify"]>>;
    try {
      claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
    } catch (e) {
      log(`[relay] client verify failed: ${(e as Error).message}`);
      ws.close(1011, "auth error");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // socket died during verify
    if (!claims) {
      ws.close(CLOSE_AUTH_REQUIRED, "auth required");
      return;
    }
    const isEntitled = entitled(claims, requiredFeature);
    if (!isEntitled && !freeTier) {
      ws.close(CLOSE_ENTITLEMENT_REQUIRED, "subscription required");
      return;
    }
    // The device must exist AND belong to this user. 4003 for both cases —
    // don't leak whether it's unknown vs someone else's.
    const userId = claims.userId;
    let owned: boolean;
    try {
      owned = (await devices.findOwned(deviceId, userId)) !== null;
    } catch (e) {
      log(`[relay] client device lookup failed: ${(e as Error).message}`);
      ws.close(1011, "registry error");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!owned) {
      ws.close(4003, "unknown device");
      return;
    }
    const clientId = hub.addClient(deviceId, ws);
    log(`[relay] client ${clientId} joined device ${deviceId}`);
    const bounce = (text: string) => {
      try {
        ws.send(JSON.stringify({ type: "error", text }));
      } catch {
        /* client teardown race */
      }
    };
    // The quota check awaits the usage store, so frames are chained through a
    // promise to keep their arrival order (a fast second frame must not
    // overtake a send that is still being metered).
    let frameChain: Promise<void> = Promise.resolve();
    let lastUsageErrLog = 0;
    const handleFrame = async (raw: string, type: unknown, authoredText: boolean) => {
      // Two different limits, on purpose (owner, 2026-07-30).
      //
      // WEEKLY QUOTA counts messages the user WROTE — that is exactly what the
      // usage meter and quota wall promise ("Only messages you send count;
      // agent replies and approvals are free"). So: `send`, `steerSend`,
      // `workflowControl`, and a plan verdict ONLY when it carries the user's
      // typed comment (that comment reaches the model as their words).
      //
      // The PER-MINUTE CAP additionally covers frames that make the model run
      // a turn without being a written message — a bare plan verdict (approve
      // starts implementing, "keep planning" writes another plan) and
      // `newSession`. Left unbounded those are a paywall loop: one paid prompt,
      // then unlimited free planning turns. Capping without charging closes it
      // while keeping the promise literally true.
      //
      // `summarizeSpeech` belongs in that same bucket (2026-08-01): each one
      // makes the HOST call xAI's Responses API on the user's key, so unbounded
      // it is a billed call the quota never sees — and since the setting now
      // defaults ON, it fires on every spoken reply rather than rarely. It is
      // not text the user wrote, so it must not eat the weekly allowance;
      // capping without charging is the same answer as for a bare verdict.
      // A bounced summarize degrades correctly: the browser already speaks the
      // original reply when no summary arrives, so nothing is lost but brevity.
      //
      // Deliberately NOT capped: `ready`/`resumeSession`, which reconnect and
      // restore depend on — throttling those would break the recovery path on
      // exactly the flaky connections that need it most.
      const chargesQuota =
        type === "send" || type === "steerSend" || type === "workflowControl" ||
        (type === "exitPlanAnswer" && authoredText);
      const capped = chargesQuota || type === "exitPlanAnswer" ||
        type === "newSession" || type === "summarizeSpeech";
      if (capped) {
        if (messageRate && !messageRate.limiter.take(userId, messageRate.perMinute)) {
          return bounce(`Slow down — at most ${messageRate.perMinute} messages per minute.`);
        }
        if (chargesQuota && !isEntitled && freeTier) {
          const win = usageWindow(Date.now());
          try {
            const count = await freeTier.usage.increment(userId, win.start);
            if (count > freeTier.weeklyMsgs) {
              return bounce(
                `Free plan limit reached (${freeTier.weeklyMsgs} messages this week). Resets in ${resetsInText(win.resetsAt - Date.now())}. Upgrade to Remote Max for unlimited use.`,
              );
            }
          } catch (e) {
            // FAIL OPEN: a usage-store outage must not block chatting —
            // availability over enforcement. Log at most once a minute.
            if (Date.now() - lastUsageErrLog > 60_000) {
              lastUsageErrLog = Date.now();
              log(`[relay] usage store error (allowing message): ${(e as Error).message}`);
            }
          }
        }
      }
      const result = hub.fromClient(deviceId, clientId, raw);
      if (result === "offline") {
        // Rendered by chat.js's normal error path — the page stays up and the
        // user re-sends once the extension reconnects.
        try {
          ws.send(JSON.stringify({ type: "error", text: "Device offline — VS Code isn't connected to the relay." }));
        } catch {
          /* client teardown race */
        }
      }
    };
    admit((raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let type: unknown;
      // Whether the frame carries text the USER WROTE — the metering test, not
      // a content read: only the emptiness of `comment` is observed, and the
      // boolean (never the text) travels on. The relay stays policy-free and
      // payload-blind; capability gating remains the extension's job.
      let authoredText = false;
      try {
        const parsed = JSON.parse(raw) as { type?: unknown; comment?: unknown };
        type = parsed.type;
        authoredText = typeof parsed.comment === "string" && parsed.comment.trim().length > 0;
      } catch {
        /* fromClient drops unparseable frames after preserving their order */
      }
      if (type === "remoteVoiceChunk") {
        // These transport ceilings must run at ingress, before frameChain can
        // await a usage-store call. Accepted frames remain chained so nothing
        // can overtake a metered send; rejection itself has no such dependency.
        if (Buffer.byteLength(raw) > MAX_REMOTE_VOICE_FRAME_BYTES) {
          ws.close(1009, "audio chunk too large");
          return;
        }
        // deviceId is credential-backed and survives browser reconnects. A
        // socket/client id would let the throttled peer mint a fresh bucket.
        if (!voiceChunkRate.limiter.take(deviceId, voiceChunkRate.perMinute)) {
          ws.close(1008, "audio chunk rate limit exceeded");
          return;
        }
      }
      frameChain = frameChain.then(() => handleFrame(raw, type, authoredText)).catch(() => undefined);
    });
    ws.on("close", () => hub.removeClient(deviceId, clientId));
    ws.on("error", () => ws.close());
  }

  server.listen(opts.port, opts.host, () => {
    log(`[relay] listening on http://${opts.host}:${(server.address() as { port: number }).port}`);
  });

  return {
    server,
    port: () => (server.address() as { port: number } | null)?.port ?? opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        if (pinger) clearInterval(pinger);
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch {
            /* best effort */
          }
        }
        wss.close();
        server.close(() => resolve());
      }),
  };
}
