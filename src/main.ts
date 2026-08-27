import { randomBytes, randomInt, randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LinkStore, makeLinkCode } from "./link-store.js";
import { createDb } from "./supabase.js";
import { InMemoryDeviceRegistry, type DeviceRegistry } from "./devices.js";
import { SupabaseDeviceRegistry } from "./devices-supabase.js";
import { MockSessionVerifier, type SessionVerifier } from "./auth.js";
import { ClerkSessionVerifier } from "./auth-clerk.js";
import { MinuteRateLimiter, type FreeTier, type MessageRate } from "./limits.js";
import { InMemoryUsageStore, type UsageStore } from "./usage.js";
import { SupabaseUsageStore } from "./usage-supabase.js";
import { Hub } from "./hub.js";
import { createRelayServer } from "./server.js";
import {
  InMemoryEnvironmentStore,
  SupabaseEnvironmentStore,
  type EnvironmentStore,
} from "./environment-store.js";
import { WakeCoordinator, spriteWaker } from "./environment-waker.js";
import { ProvisionCoordinator, parseSpriteLabels, spritesProvisioner } from "./environment-provisioner.js";
import { startWakeScheduler } from "./wake-scheduler.js";

const log = (line: string) => console.log(line);

try {
  process.loadEnvFile(); // .env in cwd — SUPABASE_URL / SUPABASE_SECRET_KEY
} catch {
  /* no .env — in-memory mode */
}

const host = process.env.RELAY_HOST || "127.0.0.1";
// RELAY_PORT wins; PORT is the PaaS convention (Railway/Heroku inject it and
// point their edge + healthcheck at it — binding elsewhere reads as down).
const port = Number(process.env.RELAY_PORT || process.env.PORT || 8787);
const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const randBytes = (n: number) => randomBytes(n);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

let devices: DeviceRegistry;
let usage: UsageStore;
if (supabaseUrl && supabaseSecretKey) {
  const pepper = process.env.DEVICE_KEYS_PEPPER;
  if (!pepper) {
    log("[relay] FATAL: DEVICE_KEYS_PEPPER is required with Supabase (HMAC device keys). Set it in .env.");
    process.exit(1);
  }
  const db = createDb(supabaseUrl, supabaseSecretKey);
  devices = new SupabaseDeviceRegistry(db, { now: Date.now, randomUUID, randomBytes: randBytes, pepper });
  // Usage counters persist next to the devices (one aggregate row per user +
  // window — deploys no longer reset the free-tier quota).
  usage = new SupabaseUsageStore(db);
  log(`[relay] device registry: Supabase (${supabaseUrl})`);
} else {
  devices = new InMemoryDeviceRegistry({ now: Date.now, randomUUID, randomBytes: randBytes, randomId: randomUUID });
  usage = new InMemoryUsageStore();
  log("[relay] device registry: in-memory (set SUPABASE_URL + SUPABASE_SECRET_KEY to persist)");
}

// Session auth: real Clerk verify when a secret key is present, else the mock.
let sessions: SessionVerifier;
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
if (clerkSecretKey) {
  const parties = (process.env.CLERK_AUTHORIZED_PARTIES ?? "").trim();
  const authorizedParties =
    parties && parties !== "*" ? parties.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  sessions = new ClerkSessionVerifier({
    secretKey: clerkSecretKey,
    issuer: process.env.CLERK_ISSUER || undefined,
    authorizedParties,
  });
  log("[relay] session auth: Clerk");
} else {
  // Permissive mock: dev pages don't send tokens yet, so an ABSENT token also
  // counts as the mock user. Unreachable in Clerk mode (different class).
  sessions = new MockSessionVerifier(true);
  log("[relay] MOCK SESSION AUTH — any/absent token is the mock user with every entitlement. Dev only.");
}

const requiredFeature = process.env.RELAY_REQUIRED_FEATURE || undefined;
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY || undefined;

// Free tier for signed-in users without the feature: RELAY_FREE_DEVICES linked
// devices + RELAY_FREE_WEEKLY_MSGS prompts/ISO-week. RELAY_FREE_DEVICES=0
// disables the free tier (hard 403/4005 gate). Meaningless without a required
// feature.
let freeTier: FreeTier | undefined;
if (requiredFeature) {
  const freeDevices = Number(process.env.RELAY_FREE_DEVICES ?? 1);
  const freeWeeklyMsgs = Number(process.env.RELAY_FREE_WEEKLY_MSGS ?? 100);
  if (freeDevices > 0) {
    freeTier = { devices: freeDevices, weeklyMsgs: freeWeeklyMsgs, usage };
    log(`[relay] free tier: ${freeDevices} device(s), ${freeWeeklyMsgs} messages/week (feature "${requiredFeature}" unlocks unlimited)`);
  } else {
    log(`[relay] free tier disabled — feature "${requiredFeature}" required for all remote use`);
  }
}

// Burst cap for everyone (abuse guard; paid included). 0 disables.
let messageRate: MessageRate | undefined;
const perMinute = Number(process.env.RELAY_MAX_MSGS_PER_MINUTE ?? 20);
if (perMinute > 0) {
  messageRate = { perMinute, limiter: new MinuteRateLimiter(Date.now) };
  log(`[relay] burst cap: ${perMinute} messages/minute per user`);
}

const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode((max) => randomInt(max)) });
const hub = new Hub(log);

// Cloud environments — machines we run, as opposed to machines people own.
//
// OFF unless SPRITES_TOKEN is set, and off is a supported configuration rather
// than a degraded one: every device is then an ordinary laptop, /api/devices
// answers exactly as it always did, and the wake endpoint 404s. That is the
// keyless dev default and it is also what production looked like yesterday.
//
// The store follows the same seam as devices: Supabase when there is a database,
// in-memory otherwise, so the whole flow can be developed with no account.
let environments: EnvironmentStore | undefined;
let waker: WakeCoordinator | undefined;
let provisioner: ProvisionCoordinator | undefined;
let stopWakeScheduler: (() => void) | undefined;
const spritesToken = process.env.SPRITES_TOKEN;
const cloudFeature = process.env.RELAY_CLOUD_FEATURE || undefined;
if (spritesToken) {
  environments = supabaseUrl && supabaseSecretKey
    ? new SupabaseEnvironmentStore(createDb(supabaseUrl, supabaseSecretKey))
    : new InMemoryEnvironmentStore();
  waker = new WakeCoordinator({
    // The API, not the sprite's public URL: a plain request to that returns 302
    // from an auth edge and never reaches the machine. SPRITES_API_BASE exists
    // for a self-hosted or staging control plane, not because the default is a
    // guess.
    wake: spriteWaker({
      token: spritesToken,
      apiBase: process.env.SPRITES_API_BASE || undefined,
    }),
    log,
  });
  // SPRITES_LABELS: comma separated, trimmed. Applied at creation and not
  // changeable afterwards without a second call, so an unlabelled sprite stays
  // unlabelled — and a console full of `afkpilot-u-<hash>` names is
  // unattributable, because the hash is deliberately not reversible.
  const spriteLabels = parseSpriteLabels(process.env.SPRITES_LABELS);
  provisioner = new ProvisionCoordinator(spritesProvisioner({
    token: spritesToken,
    apiBase: process.env.SPRITES_API_BASE || undefined,
    labels: spriteLabels,
    log,
  }));
  if (spriteLabels.length) log(`[relay] sprite labels: ${spriteLabels.join(", ")}`);
  // Scheduled wakes: the sweep that makes routines fire ON TIME on a machine
  // that sleeps. Without it routines still run — catch-up is arithmetic — but
  // only whenever somebody next opens the environment.
  stopWakeScheduler = startWakeScheduler({
    store: environments,
    coordinator: waker,
    isOnline: (deviceId) => hub.uplinkConnected(deviceId),
    log,
  });
  log(`[relay] cloud environments: enabled (${supabaseUrl ? "Supabase" : "in-memory"})`);
  // Unset = open to everyone, the same convention RELAY_REQUIRED_FEATURE uses.
  // A launch window therefore needs no timer and no code: the feature is simply
  // not configured yet, and setting it later closes the gate.
  log(cloudFeature
    ? `[relay] cloud access: requires feature "${cloudFeature}"`
    : "[relay] cloud access: OPEN to every account (set RELAY_CLOUD_FEATURE to gate it)");
  // Referenced so the stop handle is not dead code to a linter, and so a future
  // graceful-shutdown path has an obvious place to call it.
  process.once("SIGTERM", () => stopWakeScheduler?.());
} else {
  log("[relay] cloud environments: disabled (set SPRITES_TOKEN to serve hosted machines)");
}

createRelayServer({ host, port, webRoot, store, devices, sessions, requiredFeature, freeTier, messageRate, clerkPublishableKey, hub, environments, waker, provisioner, cloudFeature, log });
