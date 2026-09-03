import { describe, expect, it } from "vitest";
import {
  jitter,
  RECONNECT_CAP_MS,
  RECONNECT_FLOOR_MS,
  ReconnectBackoff,
} from "../src/reconnect-backoff.js";

function backoffAt(clock: { t: number }, random: () => number = () => 1) {
  return new ReconnectBackoff({ now: () => clock.t, random });
}

describe("ReconnectBackoff schedule", () => {
  it("first delay is the floor, jittered", () => {
    const b = backoffAt({ t: 0 }, () => 1);
    expect(b.nextDelayMs()).toBe(RECONNECT_FLOOR_MS);
  });

  it("grows by doubling and stops at the cap", () => {
    const b = backoffAt({ t: 0 }, () => 1);
    const delays = Array.from({ length: 8 }, () => b.nextDelayMs());
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(delays.every((d) => d <= RECONNECT_CAP_MS)).toBe(true);
  });

  it("jitter stays inside [half, full] of the base delay", () => {
    expect(jitter(1_000, 0)).toBe(500);
    expect(jitter(1_000, 1)).toBe(1_000);
    expect(jitter(1_000, 0.5)).toBe(750);
    expect(jitter(RECONNECT_CAP_MS, 0)).toBe(RECONNECT_CAP_MS / 2);
    expect(jitter(RECONNECT_CAP_MS, 1)).toBe(RECONNECT_CAP_MS);

    const b = backoffAt({ t: 0 }, () => 0);
    expect(b.nextDelayMs()).toBe(RECONNECT_FLOOR_MS / 2);
    expect(b.nextDelayMs()).toBe(RECONNECT_FLOOR_MS); // next base is 2s, half is 1s
  });
});

describe("reset only after a stable connection", () => {
  it("does not reset the moment a socket opens", () => {
    const clock = { t: 0 };
    const b = backoffAt(clock, () => 1);
    expect(b.nextDelayMs()).toBe(1_000);
    b.noteOpen();
    expect(b.nextDelayMs()).toBe(2_000);
  });

  it("a short-lived connection keeps growing", () => {
    const clock = { t: 10_000 };
    const b = backoffAt(clock, () => 1);
    expect(b.nextDelayMs()).toBe(1_000);
    b.noteOpen();
    clock.t = 10_000 + RECONNECT_FLOOR_MS - 1;
    b.noteClosed();
    expect(b.nextDelayMs()).toBe(2_000);
  });

  it("a connection that stayed up for the floor resets to the floor", () => {
    const clock = { t: 10_000 };
    const b = backoffAt(clock, () => 1);
    expect(b.nextDelayMs()).toBe(1_000);
    expect(b.nextDelayMs()).toBe(2_000);
    b.noteOpen();
    clock.t = 10_000 + RECONNECT_FLOOR_MS;
    b.noteClosed();
    expect(b.nextDelayMs()).toBe(1_000);
  });

  it("a close that never opened does not reset", () => {
    const clock = { t: 0 };
    const b = backoffAt(clock, () => 1);
    expect(b.nextDelayMs()).toBe(1_000);
    b.noteClosed();
    expect(b.nextDelayMs()).toBe(2_000);
  });

  it("reset() is the immediate-retry path (visible / focus / user action)", () => {
    const b = backoffAt({ t: 0 }, () => 1);
    b.nextDelayMs();
    b.nextDelayMs();
    b.nextDelayMs();
    b.reset();
    expect(b.nextDelayMs()).toBe(RECONNECT_FLOOR_MS);
  });
});
