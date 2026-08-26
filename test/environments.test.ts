/**
 * Cloud environments — the decisions, pinned.
 *
 * Two of these encode product rules that are easy to "simplify" into bugs, so
 * they are stated as behaviour rather than as assertions about fields:
 *
 *  - `offline` means UNWAKEABLE, never "asleep". A paused environment is
 *    `ready`, because to the person tapping it, it is.
 *  - an environment may not sleep while a turn is in flight, even with no
 *    client attached at all. Someone closing their laptop while an agent works
 *    for twenty minutes is the reason this product exists.
 */
import { describe, expect, it } from "vitest";
import {
  deviceAvailability,
  dueForWake,
  IDLE_HOLD_MS,
  MAX_WAKE_AHEAD_MS,
  maySleep,
  parseWakeAt,
  shouldWakeOnAttach,
  wakeDue,
  wakeFailureText,
  WAKE_TIMEOUT_MS,
  type EnvironmentRecord,
} from "../src/environments";

const NOW = 1_700_000_000_000;

const env = (over: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  deviceId: "d1",
  userId: "u1",
  provider: "sprite",
  externalId: "afkpilot-abc",
  wakeAt: null,
  createdAt: NOW - 86_400_000,
  ...over,
});

describe("what a person is shown", () => {
  it("shows a paused environment as ready, never as asleep", () => {
    // The whole model in one line: the reader has no action attached to
    // "asleep", so showing it is leaking our mechanism.
    expect(deviceAvailability({ online: false, environment: env() })).toBe("ready");
  });

  it("shows a connected device as ready whether or not it is an environment", () => {
    expect(deviceAvailability({ online: true, environment: env() })).toBe("ready");
    expect(deviceAvailability({ online: true })).toBe("ready");
  });

  it("keeps the old two-state meaning for an ordinary machine", () => {
    // A laptop that is off is off, and nothing we do changes that. Cloud and
    // desk devices legitimately speak different vocabularies.
    expect(deviceAvailability({ online: false })).toBe("offline");
    expect(deviceAvailability({ online: false, environment: null })).toBe("offline");
  });

  it("says offline only when the environment genuinely cannot be woken", () => {
    expect(deviceAvailability({ online: false, environment: env(), unwakeable: true })).toBe("offline");
  });

  it("shows waking only while a wake is actually in flight", () => {
    expect(deviceAvailability({ online: false, environment: env(), waking: true })).toBe("waking");
  });

  it("prefers offline over waking when a wake has already failed", () => {
    // Both flags can be set on the same tick — the wake was in flight and then
    // failed. Reporting "waking" there is a spinner that never resolves.
    expect(deviceAvailability({
      online: false, environment: env(), waking: true, unwakeable: true,
    })).toBe("offline");
  });
});

describe("when to wake", () => {
  it("wakes a sleeping environment on attach", () => {
    expect(shouldWakeOnAttach({ online: false, environment: env() })).toBe(true);
  });

  it("does not wake one that is already connected", () => {
    expect(shouldWakeOnAttach({ online: true, environment: env() })).toBe(false);
  });

  it("does not wake an ordinary machine — there is nothing to wake", () => {
    expect(shouldWakeOnAttach({ online: false })).toBe(false);
  });

  it("does not start a second wake while one is in flight", () => {
    expect(shouldWakeOnAttach({ online: false, environment: env(), wakeInFlight: true })).toBe(false);
  });
});

describe("when to sleep", () => {
  it("never sleeps while a turn is in flight, even with nobody attached", () => {
    // The clause that is the product. A rule counting only attached clients
    // would stop the agent the moment the person walked away.
    expect(maySleep({ turnInFlight: true, now: NOW })).toBe(false);
    expect(maySleep({
      turnInFlight: true, now: NOW, lastHeartbeatAt: NOW - IDLE_HOLD_MS * 10,
    })).toBe(false);
  });

  it("sleeps when no client has ever been and nothing is running", () => {
    expect(maySleep({ turnInFlight: false, now: NOW })).toBe(true);
  });

  it("holds while a human is still touching it", () => {
    expect(maySleep({ turnInFlight: false, now: NOW, lastHeartbeatAt: NOW - 1_000 })).toBe(false);
  });

  it("releases once the hold has elapsed", () => {
    expect(maySleep({ turnInFlight: false, now: NOW, lastHeartbeatAt: NOW - IDLE_HOLD_MS })).toBe(true);
  });

  it("takes an override, for a per-user setting later", () => {
    expect(maySleep({
      turnInFlight: false, now: NOW, lastHeartbeatAt: NOW - 61_000, idleHoldMs: 60_000,
    })).toBe(true);
  });

  it("holds for minutes, not seconds — idle is nearly free and pausing mid-turn is not", () => {
    expect(IDLE_HOLD_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("scheduled wakes", () => {
  it("is due when the host's timestamp has passed", () => {
    expect(wakeDue(env({ wakeAt: NOW - 1 }), NOW)).toBe(true);
    expect(wakeDue(env({ wakeAt: NOW + 1 }), NOW)).toBe(false);
  });

  it("is never due with nothing scheduled", () => {
    expect(wakeDue(env({ wakeAt: null }), NOW)).toBe(false);
  });

  it("returns the due ones, soonest first", () => {
    const list = [
      env({ deviceId: "late", wakeAt: NOW - 1_000 }),
      env({ deviceId: "none", wakeAt: null }),
      env({ deviceId: "later", wakeAt: NOW + 5_000 }),
      env({ deviceId: "earliest", wakeAt: NOW - 9_000 }),
    ];
    expect(dueForWake(list, NOW).map((e) => e.deviceId)).toEqual(["earliest", "late"]);
  });
});

describe("the wake time a host may ask for", () => {
  it("accepts a future timestamp", () => {
    expect(parseWakeAt(NOW + 3_600_000, NOW)).toEqual({ ok: true, wakeAt: NOW + 3_600_000 });
  });

  it("accepts null — a host with no routines must be able to clear one", () => {
    // Otherwise a stale wake outlives the routine that asked for it and the
    // machine starts up nightly for nothing.
    expect(parseWakeAt(null, NOW)).toEqual({ ok: true, wakeAt: null });
  });

  it("tolerates small clock skew but refuses a real past time", () => {
    expect(parseWakeAt(NOW - 30_000, NOW).ok).toBe(true);
    expect(parseWakeAt(NOW - 3_600_000, NOW).ok).toBe(false);
  });

  it("refuses absurdly distant times", () => {
    expect(parseWakeAt(NOW + MAX_WAKE_AHEAD_MS + 1, NOW).ok).toBe(false);
  });

  it("refuses rather than coerces rubbish", () => {
    // A clamp would turn a host scheduler bug into a machine that wakes at a
    // time nobody chose, which is harder to diagnose than a rejection.
    for (const bad of ["soon", NaN, Infinity, NOW + 0.5, {}, [], undefined, true]) {
      expect(parseWakeAt(bad, NOW).ok).toBe(false);
    }
  });
});

describe("what a failed wake says", () => {
  it("never leaks the provider's error", () => {
    const text = wakeFailureText("unavailable");
    expect(text).toMatch(/try again/i);
    expect(text).not.toMatch(/sprite|fly|api|50\d|http/i);
  });

  it("names a limit the person can actually act on", () => {
    expect(wakeFailureText("quota")).toMatch(/limit/i);
  });

  it("is honest when the environment is gone", () => {
    expect(wakeFailureText("gone")).toMatch(/no longer exists/i);
  });

  it("gives a wake long enough to succeed and short enough to fail visibly", () => {
    expect(WAKE_TIMEOUT_MS).toBeGreaterThan(2_000);
    expect(WAKE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
