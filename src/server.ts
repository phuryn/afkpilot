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
import {
  buildElapsedMs,
  cloudRowState,
  deviceAvailability,
  mayUseCloud,
  parseWakeAt,
  shouldWakeOnAttach,
} from "./environments.js";
import type { ProvisionCoordinator } from "./environment-provisioner.js";
import type { EnvironmentPoolStore } from "./environment-pool-store.js";
import { claimOutcome } from "./environment-pool.js";
import { HandoverCodes, handoverCommand, handoverEnvFile, redactCode } from "./environment-handover.js";
import { poolBootstrapScript, poolBuildCommand } from "./pool-bootstrap.js";
import { PRESENCE_TYPE, PresenceTracker } from "./presence.js";
import type { EnvironmentStore } from "./environment-store.js";
import type { WakeCoordinator } from "./environment-waker.js";
import { parseUplinkFrame, REMOTE_PROTO_VERSION, TRANSPORT_PROBE_TYPE } from "./frames.js";
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
  /**
   * Cloud environments. Absent = this relay serves no hosted machines, which is
   * the keyless dev default and stays a supported configuration: every device is
   * then an ordinary laptop and nothing below changes behaviour.
   */
  environments?: EnvironmentStore;
  /** Wakes a sleeping environment. Required only alongside `environments`. */
  waker?: WakeCoordinator;
  /** Who is watching. Injectable so tests can drive its clock. */
  presence?: PresenceTracker;
  /** Creates and destroys environments. Required alongside `environments` for
   *  lazy provisioning; without it, environments must be created by hand. */
  provisioner?: ProvisionCoordinator;
  /** The shelf of pre-built machines. Absent = every open builds on demand,
   *  which is what happened before a pool existed and still works. */
  pool?: EnvironmentPoolStore;
  /** Single-use codes a claimed machine redeems for its device token. */
  handover?: HandoverCodes;
  /**
   * This relay's own public https URL.
   *
   * A pooled machine has to be told where to phone home, and it cannot work it
   * out: it reaches us over the internet, not over the socket the host uses.
   */
  publicUrl?: string;
  /** Clerk feature gating CLOUD specifically — separate from `requiredFeature`,
   *  which gates driving your own machine. Unset = open to everyone, which is
   *  how a launch window needs no timer. */
  cloudFeature?: string;
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

/**
 * The websocket form of this relay's public URL.
 *
 * The machine is told where to dial, and it dials a socket, not a page. Derived
 * rather than configured twice: two URLs that must agree are two URLs that will
 * eventually disagree.
 */
function relayWsUrl(httpUrl: string): string {
  return httpUrl.replace(/\/+$/, "").replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

/**
 * A plain-text response.
 *
 * Two callers, both talking to a machine rather than a browser: the install
 * script a pooled sprite fetches, and the env file a claimed one collects.
 * `nosniff` because both are served as text and neither should ever be
 * interpreted as anything else by something that fetched them by accident.
 */
function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain",
): void {
  res.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

export interface RelayServer {
  server: http.Server;
  /** The actually-bound port (options.port 0 = ephemeral, for tests). */
  port: () => number;
  close: () => Promise<void>;
}

/** The raw `Authorization: Bearer <token>` value, or undefined.
 *
 *  Deliberately NOT sessionTokenFromRequest: that also reads the __session
 *  cookie, which is right for a browser and wrong for a device. A machine
 *  authenticates with its device token and nothing else, so a stray cookie on a
 *  request must never stand in for one. */
const bearerToken = (headers: { authorization?: string }): string | undefined => {
  const raw = headers.authorization;
  if (typeof raw !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() || undefined : undefined;
};

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
  const { environments, waker, provisioner, cloudFeature, pool, handover, publicUrl } = opts;
  // Who is actually watching. Client-asserted, because the relay cannot tell a
  // person reading from a tab forgotten last night — both are an open socket.
  const presence = opts.presence ?? new PresenceTracker();

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
          // A cloud environment does not count against the device limit. It is
          // a machine WE run, offered to every account including free ones, and
          // charging it against the one laptop a free user is allowed would
          // mean the offer takes something away.
          //
          // Excluded by the ENVIRONMENTS table, not by `platform === "cloud"`.
          // The platform field is self-reported by the host at link time, so a
          // client that simply claimed to be a cloud environment could mint
          // unlimited free devices. Only the relay writes environments.
          const cloudDeviceIds = environments
            ? new Set((await environments.listByUser(claims.userId).catch(() => [])).map((e) => e.deviceId))
            : new Set<string>();
          const countable = ownedDevices.filter((d) => !cloudDeviceIds.has(d.deviceId));
          const owned = countMachines([...countable, { installId: info.installId }]);
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
      if (req.method === "GET" && p === "/api/environment/pool-bootstrap.sh") {
        // The install script a pooled machine fetches. PUBLIC and secret-free
        // on purpose: exec takes no stdin and returns no output, so a URL is
        // the only thing that fits in the command line, and serving it means a
        // broken build step is fixed by a deploy rather than by rebuilding a
        // shelf of machines.
        if (!pool || !publicUrl) return sendText(res, 404, "not found");
        return sendText(res, 200, poolBootstrapScript({ relayHttpUrl: publicUrl }), "text/x-shellscript");
      }
      if (req.method === "POST" && p === "/api/environment/pool/ready") {
        // A machine saying its install finished.
        //
        // Unauthenticated in the session sense — there is no user here, and
        // will not be until somebody claims it. The per-row secret is what
        // makes it safe: without it, guessing a name would put a half-built box
        // in front of the next person who opens a cloud environment.
        if (!pool) return sendJson(res, 404, { ok: false, error: "not-supported" });
        const body = await readJsonBody(req).catch(() => null) as { name?: string; secret?: string } | null;
        if (!body?.name || !body?.secret) return sendJson(res, 400, { ok: false, error: "bad-request" });
        const ok = await pool.markReady(body.name, body.secret, Date.now()).catch(() => false);
        if (!ok) {
          // Deliberately the same answer for a wrong secret, an unknown name
          // and a machine somebody already has: a caller who is guessing
          // learns nothing from any of them.
          log(`[relay] pool readiness refused for ${body.name}`);
          return sendJson(res, 403, { ok: false, error: "refused" });
        }
        log(`[relay] pool: ${body.name} is ready`);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/environment/handover") {
        // A claimed machine collecting its identity.
        //
        // The code is single-use and short-lived, and this is the only place a
        // device token is ever written to a response body. It goes to the
        // MACHINE, over TLS, in exchange for something that is worthless a
        // moment later — which is what lets the token stay out of the command
        // line, and out of the provider's control-plane record.
        if (!handover) return sendJson(res, 404, { ok: false, error: "not-supported" });
        const code = String(req.headers["x-handover-code"] ?? "");
        const payload = code ? handover.redeem(code) : null;
        if (!payload) {
          log(`[relay] handover refused (${code ? redactCode(code) : "no code"})`);
          return sendJson(res, 403, { ok: false, error: "refused" });
        }
        log(`[relay] handover redeemed for ${payload.deviceId}`);
        return sendText(res, 200, handoverEnvFile(payload), "text/plain");
      }
      if (req.method === "POST" && p === "/api/cloud/open") {
        // Open my cloud environment, creating it if this is the first time.
        //
        // LAZY: an account that never taps the row costs nothing at all. Most
        // never will, and provisioning at signup would buy a machine for every
        // one of them.
        //
        // Returns the deviceId to open, so the browser can navigate straight to
        // /chat. Attaching there is what WAKES it; this only makes sure there is
        // something to attach to.
        if (!environments || !provisioner) return sendJson(res, 404, { ok: false, error: "not-supported" });
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        if (!mayUseCloud(claims.features, cloudFeature)) {
          // Named separately from every other refusal because it is the one the
          // person can act on, and the page turns it into an upgrade rather
          // than an error.
          return sendJson(res, 403, { ok: false, error: "upgrade" });
        }
        const existing = (await environments.listByUser(claims.userId).catch(() => []))[0];
        if (existing) return sendJson(res, 200, { ok: true, deviceId: existing.deviceId });

        // THE SHELF FIRST. A pooled machine is already installed, so claiming
        // one turns a twenty-five-minute build into handing over a token. An
        // empty shelf is NOT a failure — it is the on-demand path below, which
        // is what every open did before a pool existed and is therefore the
        // path that is actually tested.
        let externalId: string | null = null;
        let claimedFromPool = false;
        if (pool) {
          const outcome = claimOutcome(await pool.claim().catch(() => null));
          if (outcome.ok) {
            externalId = outcome.externalId;
            claimedFromPool = true;
            log(`[relay] claimed ${outcome.externalId} from the pool for ${claims.userId}`);
          }
        }

        if (!externalId) {
          const made = await provisioner.create(claims.userId);
          if (!made.ok) {
            return sendJson(res, made.kind === "quota" ? 429 : 503, { ok: false, error: made.kind });
          }
          externalId = made.externalId;
        }
        // The device row and its token come from the SAME registry every other
        // machine uses — a cloud environment is a linked device that happens to
        // be ours, and giving it a private path would mean two things to keep
        // in step.
        const issued = await devices.issue("Cloud", claims.userId, undefined, {
          clientLabel: "by afkpilot.com",
          platform: "cloud",
        });
        await environments.create({
          deviceId: issued.deviceId,
          userId: claims.userId,
          provider: "sprite",
          externalId,
        });

        if (claimedFromPool) {
          // The pool row has done its job; the environments row owns the
          // machine now. Removed AFTER that row exists, so a crash in between
          // leaves a `claimed` row an operator can see rather than a sprite
          // nothing refers to.
          await pool!.remove(externalId).catch(() => false);
        }

        // EVERY new machine gets set up, however it was obtained.
        //
        // This used to run only for a machine taken off the shelf, and the gap
        // was not theoretical: opening a cloud environment while the pool was
        // empty produced a sprite that nothing was ever installed on. It came
        // up, sat there, and the picker counted "creating" upwards forever
        // because nothing was ever going to link. A pooled machine needs only
        // its identity; a made-to-order one needs the installer too.
        if (handover && provisioner && publicUrl) {
          const code = handover.mint({
            deviceId: issued.deviceId,
            token: issued.token,
            relayUrl: relayWsUrl(publicUrl),
          });
          const relayHttpUrl = publicUrl;
          const target = externalId;
          log(`[relay] handover ${redactCode(code)} -> ${target}`);
          // Not awaited: the person is waiting on a response, and the machine
          // takes minutes either way. The row says "creating" until its uplink
          // arrives, which is the honest thing to show and the only signal that
          // means the setup actually worked.
          void (async () => {
            if (!claimedFromPool) {
              // No shelf row to report against, so no name or secret — the
              // script skips its readiness report and waits for the env file.
              const built = await provisioner.exec(
                target, poolBuildCommand({ relayHttpUrl }),
              ).catch((e: unknown) => ({ ok: false, exitCode: null, output: "", error: String(e) }));
              if (!built.ok || built.exitCode !== 0) {
                log(`[relay] installer setup failed on ${target}: `
                  + `${built.error ?? `exit ${built.exitCode}`}`);
              }
            }
            const handed = await provisioner.exec(
              target, handoverCommand({ relayHttpUrl, code }),
            ).catch((e: unknown) => ({ ok: false, exitCode: null, output: "", error: String(e) }));
            if (!handed.ok || handed.exitCode !== 0) {
              log(`[relay] handover failed on ${target}: `
                + `${handed.error ?? `exit ${handed.exitCode}`}`);
            }
          })();
        }
        log(`[relay] provisioned cloud environment for ${claims.userId}`);
        // The token goes to the MACHINE, never to the browser: it is handed to
        // the sprite as a secret when it boots. The page gets an id it may open.
        return sendJson(res, 200, { ok: true, deviceId: issued.deviceId, provisioned: true });
      }
      if (req.method === "POST" && p === "/api/cloud/reset") {
        // Reset my Cloud — destroy everything and start again.
        //
        // There is deliberately no "remove" for a cloud environment. Removing it
        // would leave an account with a product it cannot get back without
        // support, and the row would vanish from a picker that promises everyone
        // has one. Reset is the honest operation: same account, same row, new
        // machine, nothing kept.
        if (!environments || !provisioner) return sendJson(res, 404, { ok: false, error: "not-supported" });
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        const existing = (await environments.listByUser(claims.userId).catch(() => []))[0];
        // Nothing to reset is a success, not an error: the end state the caller
        // asked for is the end state they have.
        if (!existing) return sendJson(res, 200, { ok: true, reset: false });

        const gone = await provisioner.destroy(existing.externalId);
        if (!gone) return sendJson(res, 503, { ok: false, error: "unavailable" });
        // Bookkeeping AFTER the machine is actually gone. The other order leaves
        // a sprite nobody has a record of, which is a bill with no owner.
        await environments.remove(existing.deviceId).catch(() => false);
        await devices.revoke(existing.deviceId).catch(() => false);
        log(`[relay] reset cloud environment for ${claims.userId}`);
        // Not re-provisioned here. The ROW never goes away — every account has
        // one whether or not a machine backs it — so the person is never left
        // without a way in, and the machine itself waits for the next open. That
        // is the same path a first-time user takes, and therefore the one that
        // is actually tested.
        return sendJson(res, 200, { ok: true, reset: true });
      }
      if (req.method === "POST" && p === "/api/environment/wake-at") {
        // The host tells the relay when to wake it next. ONE timestamp.
        //
        // This is what keeps routines working on a machine that sleeps without
        // making this database a payload store. The host already computes its
        // own next due window — routines.ts, where catch-up is arithmetic — so
        // it can simply say WHEN. The relay never learns the cron, the routine's
        // name, or its prompt.
        //
        // Authenticated by the DEVICE token, not a user session: the machine is
        // scheduling its own wake, and nothing else should be able to. The
        // store scopes the write by userId as well, so a token for one account
        // cannot schedule a wake on another's environment.
        if (!environments) return sendJson(res, 404, { ok: false, error: "not-supported" });
        const token = bearerToken(authHeaders(req));
        const device = token ? await devices.verify(token) : null;
        if (!device) return sendJson(res, 401, { ok: false, error: "auth" });
        const body = await readJsonBody(req);
        const parsed = parseWakeAt(body?.wakeAt, Date.now());
        if (!parsed.ok) return sendJson(res, 400, { ok: false, error: "bad-request", reason: parsed.reason });
        const written = await environments
          .setWakeAt(device.deviceId, device.userId, parsed.wakeAt)
          .catch(() => false);
        // A device that is not an environment gets a plain no — it has no
        // sleeping to be woken from, and pretending otherwise would hide a
        // misconfigured host.
        if (!written) return sendJson(res, 404, { ok: false, error: "not-an-environment" });
        return sendJson(res, 200, { ok: true, wakeAt: parsed.wakeAt });
      }
      if (req.method === "GET" && p === "/api/devices") {
        // ALL the caller's devices — offline ones included, so the device
        // manager can show and remove them. Liveness/viewers from the hub.
        const claims = await sessions.verify(sessionTokenFromRequest(authHeaders(req)));
        if (!claims) return sendJson(res, 401, { ok: false, error: "auth" });
        const owned = await devices.listByUser(claims.userId);
        // One query for the caller's environments, not one per device.
        const envs = environments ? await environments.listByUser(claims.userId) : [];
        const envByDevice = new Map(envs.map((e) => [e.deviceId, e]));
        // EVERY account gets a cloud row, entitled or not, provisioned or not.
        // A machine that only appears once you have paid for it is a product
        // nobody discovers; one that appears with an upgrade on it is an offer.
        //
        // `deviceId` is null until a sprite exists, which is what makes the row
        // synthetic: there is nothing in the registry to point at yet, and
        // opening it is what creates one.
        const cloudRow = environments
          ? (() => {
            const environment = envs[0] ?? null;
            const state = cloudRowState({
              entitled: mayUseCloud(claims.features, cloudFeature),
              environment,
            });
            // A real device row exists from the moment the machine is
            // provisioned, not from the moment it works. The synthetic row is
            // for accounts with NOTHING — anything else, including a machine
            // that is still being built, is that device's own row saying what
            // is happening to it.
            if (environment) return null;
            return {
              deviceId: null,
              name: "Cloud",
              // Nothing exists to have been created. The branch above returned
              // for every case where something does.
              createdAt: null,
              online: false,
              clients: 0,
              clientLabel: "by afkpilot.com",
              platform: "cloud",
              osLabel: null,
              availability: state === "upgrade" ? "upgrade" : "ready",
              environment: { provider: "sprite", state },
            };
          })()
          : null;
        const list = owned.map((d) => {
          const environment = envByDevice.get(d.deviceId) ?? null;
          const online = hub.uplinkConnected(d.deviceId);
          return {
            deviceId: d.deviceId,
            name: d.name,
            createdAt: d.createdAt,
            online,
            clients: hub.clientCount(d.deviceId),
            clientLabel: d.clientLabel ?? null,
            platform: d.platform ?? null,
            osLabel: d.osLabel ?? null,
            // `online` above stays exactly what it always was, so nothing that
            // reads it changes. `availability` is the field a picker should
            // render: for a hosted machine, asleep-but-wakeable reads as ready,
            // because to the person tapping it, it is.
            availability: environment && environment.readyAt === null
              // Under construction. Not offline, not wakeable, not an error —
              // there is simply nothing on the other end YET, and the row says
              // so with a clock rather than with a word that means "switched
              // off at the wall".
              ? "building"
              : deviceAvailability({
                online,
                environment,
                waking: waker?.waking(d.deviceId) ?? false,
                unwakeable: !!waker?.failure(d.deviceId),
              }),
            // Presence of this object is how a client knows the row is a hosted
            // machine at all. Deliberately carries no provider identity: the
            // sprite's name is ours, not the reader's.
            //
            // `state` and `buildingForMs` are what let a picker say "being
            // made, 4:12 so far" instead of "offline" — see EnvironmentRecord
            // .readyAt for why those are different things. Elapsed rather than
            // remaining: a pool claim is seconds and a cold build is twenty-five
            // minutes, so any estimate spanning both would be a lie in one
            // direction. A number that only counts up is true either way.
            environment: environment
              ? {
                provider: environment.provider,
                state: cloudRowState({
                  entitled: mayUseCloud(claims.features, cloudFeature),
                  environment,
                }),
                buildingForMs: environment.readyAt === null
                  ? buildElapsedMs({ environment, now: Date.now() })
                  : null,
              }
              : null,
          };
        });
        // The cloud row leads: it is the one machine a person did not have to
        // set up, so it is the one they are most likely to want.
        return sendJson(res, 200, { devices: cloudRow ? [cloudRow, ...list] : list });
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
            // Clamped: over-quota attempts still increment the stored count
            // (atomic increment-then-check — delivery was possible), but the
            // meter shows at most the cap — "5 / 2" would read like a bug.
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
    // A cloud environment linking for the FIRST time stops being "building".
    //
    // Observed here rather than reported by the machine, because the relay
    // already watches exactly this event for every device it serves, and an
    // observation beats a claim. Not awaited: a database write must never sit
    // between a host connecting and its traffic flowing, and the store's own
    // `is null` guard makes a repeat harmless.
    if (environments) {
      void environments.markReady(device.deviceId, Date.now())
        .then((first) => {
          if (first) log(`[relay] cloud environment ready: ${device.deviceId}`);
        })
        .catch(() => {});
    }
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

      // WAKE ON DROP — the counterpart to wake-on-attach, and the case that was
      // missing.
      //
      // Wake-on-attach covers somebody arriving at a sleeping machine. It does
      // NOT cover the machine going to sleep underneath somebody who is already
      // there: a hosted environment pauses when idle, which kills its outbound
      // socket, and no new attach ever happens — so the page sat there saying
      // the environment was not responding while nothing was going to wake it.
      //
      // Gated on PRESENCE, not on a socket being open. A browser tab left open
      // overnight is not a reason to keep a machine awake and billing; a person
      // who was interacting a moment ago is.
      if (environments && waker && presence?.present(device.deviceId)) {
        void (async () => {
          const environment = await environments.find(device.deviceId).catch(() => null);
          if (!environment) return;
          if (hub.uplinkConnected(device.deviceId)) return; // it already came back
          if (waker.waking(device.deviceId)) return;
          log(`[relay] uplink dropped with someone present; waking ${device.deviceId}`);
          const outcome = await waker.wake(environment);
          if (!outcome.ok) {
            log(`[relay] wake on drop failed for ${device.deviceId}: ${outcome.kind}`);
          }
        })();
      }
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

    // WAKE ON ATTACH — on attach, never on listing.
    //
    // A picker showing three environments would otherwise start all three so
    // somebody could glance at the page and pay for it. Attaching is the signal
    // that a person actually wants this one.
    //
    // Deliberately not awaited. The browser has already joined and will get its
    // snapshot the moment the host dials back in; blocking the socket here
    // would add the whole wake to the time before anything renders, and a wake
    // that fails would look like a page that failed.
    if (environments && waker) {
      void (async () => {
        const environment = await environments.find(deviceId).catch(() => null);
        if (!shouldWakeOnAttach({
          online: hub.uplinkConnected(deviceId),
          environment,
          wakeInFlight: waker.waking(deviceId),
        })) return;
        // `environment` is non-null here — shouldWakeOnAttach returns false
        // without one — but the compiler cannot see that through the helper.
        if (!environment) return;
        const outcome = await waker.wake(environment);
        if (!outcome.ok) {
          log(`[relay] wake on attach failed for ${deviceId}: ${outcome.kind}`);
        }
      })();
    }
    const bounce = (text: string, submissionId?: string) => {
      try {
        // submissionId is a correlation token only — copied from the refused
        // frame so the browser can hold that send and no other. Never stored.
        ws.send(JSON.stringify({
          type: "error",
          text,
          ...(submissionId ? { submissionId } : {}),
        }));
      } catch {
        /* client teardown race */
      }
    };
    // The quota check awaits the usage store, so frames are chained through a
    // promise to keep their arrival order (a fast second frame must not
    // overtake a send that is still being metered).
    let frameChain: Promise<void> = Promise.resolve();
    let lastUsageErrLog = 0;
    const handleFrame = async (
      raw: string,
      type: unknown,
      authoredText: boolean,
      submissionId?: string,
    ) => {
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
      // ROUTINES (2026-08-24). A routine is a prompt the user wrote, stored and
      // replayed on a schedule, so the two limits split along the same seam as
      // everything above.
      //
      // `saveRoutine` CHARGES: the draft carries text the user typed, and it is
      // going to reach the model. Saving is when they wrote it, so that is when
      // it counts — which keeps the meter's promise literally true rather than
      // carving out an exception for a message that happens to be delivered
      // later. Editing charges too; the prompt can be rewritten entirely, and a
      // free rewrite would be the same loop through a different door.
      //
      // `runRoutineNow` is CAPPED but does not charge, exactly like
      // `newSession`: it makes the model run a turn without being a written
      // message. Left uncapped it is the paywall loop this comment already
      // describes — one paid routine, then unlimited free turns from a phone,
      // because the run itself is dispatched host-side and never crosses the
      // relay to be counted.
      //
      // `deleteRoutine`, `setRoutinePaused` and `listRoutines` are neither:
      // they write no prompt and start no turn.
      const chargesQuota =
        type === "send" || type === "steerSend" || type === "workflowControl" ||
        type === "saveRoutine" ||
        (type === "exitPlanAnswer" && authoredText);
      const capped = chargesQuota || type === "exitPlanAnswer" ||
        type === "newSession" || type === "summarizeSpeech" ||
        type === "runRoutineNow";
      if (capped) {
        // Delivery is the only thing that costs — weekly quota or burst
        // token. The client retries a Device-offline bounce automatically,
        // so metering first would bill the same typed prompt twice.
        if (!hub.uplinkConnected(deviceId)) {
          return bounce("Device offline — VS Code isn't connected to the relay.", submissionId);
        }
        if (messageRate && !messageRate.limiter.take(userId, messageRate.perMinute)) {
          return bounce(`Slow down — at most ${messageRate.perMinute} messages per minute.`, submissionId);
        }
        if (chargesQuota && !isEntitled && freeTier) {
          const win = usageWindow(Date.now());
          try {
            const count = await freeTier.usage.increment(userId, win.start);
            if (count > freeTier.weeklyMsgs) {
              // States the fact and stops. The upsell used to live here, but
              // this text is painted in the transcript of EVERY client —
              // including the native app, where an upgrade offer is a store
              // rejection (App Store 3.1.1). Merchandising belongs to the
              // client, which knows what it is: the web quota wall still
              // carries a real Upgrade link, the app's deliberately does not.
              // Keeping it off the wire means the relay needs no notion of
              // who is listening.
              return bounce(
                `Free plan limit reached (${freeTier.weeklyMsgs} messages this week). Resets in ${resetsInText(win.resetsAt - Date.now())}.`,
                submissionId,
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
        // Uncapped frames (ready) must still reach fromClient so an offline
        // tabToken is kept. Capped frames only land here if the uplink
        // dropped during increment; UsageStore cannot refund.
        bounce("Device offline — VS Code isn't connected to the relay.", submissionId);
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
      // Copied onto Device-offline / quota / rate-limit bounces so the
      // browser can correlate without reading prompt text.
      let submissionId: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { type?: unknown; comment?: unknown; submissionId?: unknown };
        type = parsed.type;
        authoredText = typeof parsed.comment === "string" && parsed.comment.trim().length > 0;
        if (typeof parsed.submissionId === "string" && parsed.submissionId) {
          submissionId = parsed.submissionId;
        }
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
      // frameChain exists to preserve order of frames that reach the host.
      // The probe is never forwarded, so that order does not apply to it —
      // a free-tier send awaiting the usage store must not starve the
      // liveness reply past the client's timeout.
      if (type === TRANSPORT_PROBE_TYPE) {
        hub.fromClient(deviceId, clientId, raw);
        return;
      }
      // Presence: answered here, never forwarded. The host has no use for it —
      // whether a person is looking is a fact about the browser, and the only
      // consumer is the decision about whether a hosted machine may sleep.
      //
      // Ahead of frameChain for the same reason as the probe: it must not queue
      // behind a send that is waiting on the usage store, or a slow quota check
      // would read as somebody leaving the room.
      if (type === PRESENCE_TYPE) {
        let present = true;
        try {
          present = (JSON.parse(raw) as { present?: unknown }).present !== false;
        } catch {
          /* malformed frame — treat as a plain heartbeat */
        }
        if (present) presence.touch(deviceId);
        else presence.clear(deviceId);
        return;
      }
      frameChain = frameChain.then(() => handleFrame(raw, type, authoredText, submissionId)).catch(() => undefined);
    });
    ws.on("close", () => {
      hub.removeClient(deviceId, clientId);
      // A socket closing is not by itself proof nobody is there — another tab
      // may still be open, and two tabs are one person's attention.
      presence.forgetIfLastClient(deviceId, hub.clientCount(deviceId));
    });
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
