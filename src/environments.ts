/**
 * Cloud environments — the pure decisions.
 *
 * A cloud environment is a linked device that happens to be a machine we run.
 * Everything else about it is already handled: it links through
 * `/api/link/start` like any host, appears in the device registry, routes
 * through the hub, and obeys the extension's policy table. The relay learns
 * exactly ONE new thing about it — **how to wake it** — and this module holds
 * the decisions that follow from that.
 *
 * ## Why the relay has to be involved at all
 *
 * The uplink is outbound-only. When an environment sleeps, that socket dies,
 * and a sleeping environment is then indistinguishable from a laptop that is
 * switched off. Nothing can be sent to it, because the thing you would send it
 * over is gone. So a wake is an inbound call the RELAY makes — and only the
 * relay can, because only the relay knows a client is asking.
 *
 * ## Keeping one awake is not solved yet
 *
 * Fly's docs say a registered Service does NOT keep a sprite from pausing, and
 * point at a Tasks API instead. That endpoint returns 404 on our org (measured
 * 2026-08-27). What works today is holding an active session, which is ugly at
 * scale — one held session per awake environment.
 *
 * This module deliberately does not encode either mechanism. It decides WHETHER
 * an environment may sleep ({@link maySleep}); the how is a provider concern and
 * is expected to change.
 *
 * ## Payloads stay ephemeral
 *
 * The temptation with scheduled waking is to teach the relay about routines:
 * their cron, their prompt, their name. That would be a payload store, and this
 * relay does not have one.
 *
 * Instead the HOST computes its own next due time and tells the relay a single
 * timestamp: "wake me at T". The relay stores one nullable column and knows
 * nothing about why. Same class as `usage_counters` — an aggregate per user,
 * not a record of what they said. A routine's schedule, prompt and name never
 * leave the environment.
 */

/** Where an environment runs. Only one provider today; the shape is here so a
 *  second one does not require reshaping the table or these decisions. */
export type EnvironmentProvider = "sprite";

export interface EnvironmentRecord {
  deviceId: string;
  userId: string;
  provider: EnvironmentProvider;
  /** Provider-side identity — a sprite name. */
  externalId: string;
  /** Next scheduled wake, epoch ms, or null when nothing is due. Written by
   *  the host from its own routine schedule; the relay never computes it. */
  wakeAt: number | null;
  createdAt: number;
}

/**
 * What a person is shown for a device.
 *
 * Deliberately NOT the provider's vocabulary. "warm" and "cold" are facts about
 * a hypervisor that no reader can act on, and showing them invites someone to
 * reason about a machine they do not administer. What a reader needs is whether
 * they can use it.
 *
 * `offline` therefore means **cannot be woken**, not "currently asleep". An
 * environment that is paused is `ready`: from the outside, tapping it works.
 */
export type DeviceAvailability = "ready" | "waking" | "offline";

export interface AvailabilityInput {
  /** Hub state — is the uplink socket up right now. */
  online: boolean;
  /** The environment record, when this device is one. */
  environment?: EnvironmentRecord | null;
  /** A wake this relay started and has not seen land yet. */
  waking?: boolean;
  /** Set when a wake attempt failed, or the environment is gone. */
  unwakeable?: boolean;
}

/**
 * What the picker should say.
 *
 * A device with no environment record is an ordinary machine and keeps the old
 * two-state meaning: connected, or not, with nothing anyone can do about it.
 */
export function deviceAvailability(input: AvailabilityInput): DeviceAvailability {
  if (input.online) return "ready";
  if (!input.environment) return "offline";
  if (input.unwakeable) return "offline";
  if (input.waking) return "waking";
  // Asleep but wakeable. The whole point: this reads the same as ready, because
  // to the person tapping it, it is.
  return "ready";
}

/**
 * Should attaching a client wake this environment?
 *
 * Attach, never *list*. A picker showing three environments would otherwise
 * wake all three so somebody could glance at the page, and pay for it.
 */
export function shouldWakeOnAttach(input: {
  online: boolean;
  environment?: EnvironmentRecord | null;
  wakeInFlight?: boolean;
}): boolean {
  if (input.online) return false;
  if (!input.environment) return false;
  return !input.wakeInFlight;
}

/** How long a wake may take before it is reported as a failure. Cold wake was
 *  measured at ~655 ms and the provider documents 1–2 s; 30 s is far past any
 *  honest wake and well short of a person's patience for a spinner. */
export const WAKE_TIMEOUT_MS = 30_000;

/**
 * How long an environment is held awake after the last sign of a human.
 *
 * Generous on purpose. Once Fly's own pricing example established that Sprites
 * meters ACTUAL usage — a 4-hour session billing 2.4 CPU-hours, not 32 — an
 * attached-but-idle environment costs two or three cents an hour. There is no
 * longer a cost argument for a twitchy timeout, and a twitchy one risks the
 * thing that actually matters: pausing mid-turn.
 */
export const IDLE_HOLD_MS = 5 * 60_000;

export interface SleepInput {
  /** Last client heartbeat, epoch ms. Undefined = no client has ever been. */
  lastHeartbeatAt?: number;
  /** The host says an agent turn is in flight. */
  turnInFlight: boolean;
  now: number;
  /** Override for tests and for a future per-user setting. */
  idleHoldMs?: number;
}

/**
 * May this environment be allowed to sleep?
 *
 * The second clause is the entire product. Someone closing their laptop while
 * an agent works for twenty minutes is not idle — they are the reason this
 * exists. A rule that only counted attached clients would stop the work the
 * moment the person walked away, which is the worst bug this system could have.
 */
export function maySleep(input: SleepInput): boolean {
  if (input.turnInFlight) return false;
  if (input.lastHeartbeatAt === undefined) return true;
  const hold = input.idleHoldMs ?? IDLE_HOLD_MS;
  return input.now - input.lastHeartbeatAt >= hold;
}

/**
 * Is a scheduled wake due?
 *
 * `wakeAt` is a bare timestamp the host asked for. The relay does not know
 * whether it is a routine, which routine, or what it will do — and must not,
 * because that would be a payload.
 */
export function wakeDue(environment: EnvironmentRecord, now: number): boolean {
  return environment.wakeAt !== null && environment.wakeAt <= now;
}

/** Environments with a scheduled wake now due, soonest first. */
export function dueForWake(
  environments: readonly EnvironmentRecord[],
  now: number,
): EnvironmentRecord[] {
  return environments
    .filter((e) => wakeDue(e, now))
    .sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0));
}

/**
 * Validate a host-supplied wake time.
 *
 * Refused rather than clamped, because a clamp turns a bug in the host's
 * scheduler into a mystery wake at an arbitrary time. A rejected value leaves
 * the previous schedule alone and says so.
 *
 * `null` is legal and means "nothing scheduled" — a host with no routines must
 * be able to say that, otherwise a stale wake outlives the routine that asked
 * for it.
 */
export const MAX_WAKE_AHEAD_MS = 400 * 24 * 60 * 60_000;

export function parseWakeAt(raw: unknown, now: number): { ok: true; wakeAt: number | null } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, wakeAt: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, reason: "wakeAt must be a number of epoch milliseconds, or null" };
  }
  if (!Number.isInteger(raw)) return { ok: false, reason: "wakeAt must be a whole number of milliseconds" };
  // A time already past would wake the machine immediately and forever, since
  // nothing clears it. Slightly-past is normal clock skew and is allowed.
  if (raw < now - 60_000) return { ok: false, reason: "wakeAt is in the past" };
  if (raw > now + MAX_WAKE_AHEAD_MS) return { ok: false, reason: "wakeAt is too far ahead" };
  return { ok: true, wakeAt: raw };
}

/**
 * What a failed wake says to a person.
 *
 * Never the provider's error. "Sprites API returned 503" is our problem
 * appearing on someone's screen, and there is nothing they can do with it. The
 * one exception is a limit they can actually act on, which is why `quota` is a
 * separate kind rather than a message string.
 */
export type WakeFailure = "unavailable" | "quota" | "gone";

export function wakeFailureText(kind: WakeFailure): string {
  switch (kind) {
    case "quota":
      return "You've reached your plan's limit for running environments.";
    case "gone":
      return "This environment no longer exists.";
    case "unavailable":
      return "Couldn't start this environment. Try again.";
  }
}
