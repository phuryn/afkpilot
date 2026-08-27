/**
 * Presence — a claim, not an observation.
 *
 * The relay cannot see a person; an open socket looks identical whether someone
 * is reading or the tab was forgotten last night. These tests pin what the relay
 * does with a claim it cannot verify, and in particular that presence is only
 * ONE of the reasons to stay awake — an agent turn keeps a machine up with
 * nobody watching at all, which is the product.
 */
import { describe, expect, it } from "vitest";
import {
  isPresenceFrame,
  PRESENCE_INTERVAL_MS,
  PRESENCE_TTL_MS,
  PresenceTracker,
} from "../src/presence";
import { maySleep } from "../src/environments";

const NOW = 1_700_000_000_000;

function trackerAt(clock: { t: number }) {
  return new PresenceTracker(() => clock.t);
}

describe("holding a claim", () => {
  it("remembers a heartbeat", () => {
    const clock = { t: NOW };
    const p = trackerAt(clock);
    p.touch("d1");
    expect(p.present("d1")).toBe(true);
    expect(p.lastHeartbeatAt("d1")).toBe(NOW);
  });

  it("knows nothing about a device nobody has claimed", () => {
    expect(new PresenceTracker(() => NOW).present("d1")).toBe(false);
  });

  it("expires a stale claim", () => {
    const clock = { t: NOW };
    const p = trackerAt(clock);
    p.touch("d1");
    clock.t = NOW + PRESENCE_TTL_MS + 1;
    expect(p.present("d1")).toBe(false);
  });

  it("survives one dropped frame", () => {
    // The TTL must be comfortably longer than the send interval, or a single
    // lost heartbeat reads as somebody leaving the room.
    expect(PRESENCE_TTL_MS).toBeGreaterThan(PRESENCE_INTERVAL_MS * 2);
  });

  it("forgets on read, so an abandoned device does not leak an entry", () => {
    const clock = { t: NOW };
    const p = trackerAt(clock);
    p.touch("d1");
    clock.t = NOW + PRESENCE_TTL_MS + 1;
    p.present("d1");
    expect(p.size()).toBe(0);
  });

  it("lets a client withdraw immediately", () => {
    // A backgrounded tab can say so at once. Holding a machine awake for
    // another ninety seconds because a phone went into a pocket is waste.
    const p = new PresenceTracker(() => NOW);
    p.touch("d1");
    p.clear("d1");
    expect(p.present("d1")).toBe(false);
  });

  it("treats two tabs as one person's attention", () => {
    const clock = { t: NOW };
    const p = trackerAt(clock);
    p.touch("d1");
    clock.t = NOW + 1_000;
    p.touch("d1");
    // One client leaving while another remains must not withdraw presence.
    p.forgetIfLastClient("d1", 1);
    expect(p.present("d1")).toBe(true);
    p.forgetIfLastClient("d1", 0);
    expect(p.present("d1")).toBe(false);
  });
});

describe("what presence decides, and what it does not", () => {
  it("keeps an environment awake while somebody is watching", () => {
    const p = new PresenceTracker(() => NOW);
    p.touch("d1");
    expect(maySleep({ lastHeartbeatAt: p.lastHeartbeatAt("d1"), turnInFlight: false, now: NOW })).toBe(false);
  });

  it("lets it sleep once nobody is", () => {
    const p = new PresenceTracker(() => NOW);
    expect(maySleep({ lastHeartbeatAt: p.lastHeartbeatAt("d1"), turnInFlight: false, now: NOW })).toBe(true);
  });

  it("does NOT let it sleep during a turn, however long nobody has watched", () => {
    // The clause that is the product: closing your laptop while an agent works
    // for twenty minutes is not idleness.
    const p = new PresenceTracker(() => NOW);
    expect(maySleep({
      lastHeartbeatAt: p.lastHeartbeatAt("d1"),
      turnInFlight: true,
      now: NOW + 60 * 60_000,
    })).toBe(false);
  });
});

describe("the frame", () => {
  it("recognises a presence frame and nothing else", () => {
    expect(isPresenceFrame({ type: "presence" })).toBe(true);
    expect(isPresenceFrame({ type: "send" })).toBe(false);
    expect(isPresenceFrame({} as { type?: unknown })).toBe(false);
  });
});
