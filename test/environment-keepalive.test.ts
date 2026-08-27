/**
 * Holding a working machine awake.
 *
 * Every hold costs money for as long as it exists, and every missing hold costs
 * somebody their turn. So the tests here are about exactly two failures: paying
 * for a machine that is not working, and failing to pay for one that is.
 *
 * The measurement this rests on (2026-08-27): a Sprite suspends about a minute
 * after the last external interaction, and suspended is FROZEN — a service
 * writing a timestamp every five seconds stopped dead the moment the machine
 * went `warm`. Its own output bought it nothing. A held-open session is what
 * keeps it `running`.
 */
import { describe, expect, it } from "vitest";
import {
  KeepAliveCoordinator,
  KEEPALIVE_IDLE_MS,
  startKeepAliveSweeper,
} from "../src/environment-keepalive";

function coordinator(startAt = 0) {
  const opened: string[] = [];
  const released: string[] = [];
  let now = startAt;
  const c = new KeepAliveCoordinator({
    hold: (externalId) => {
      opened.push(externalId);
      return { release: () => { released.push(externalId); } };
    },
    now: () => now,
    log: () => {},
  });
  return { c, opened, released, tick: (ms: number) => { now += ms; } };
}

describe("starting to hold", () => {
  it("holds a machine the moment a frame arrives from it", () => {
    const { c, opened } = coordinator();
    c.noteActivity("d1", "sprite-1");
    expect(opened).toEqual(["sprite-1"]);
    expect(c.holding("d1")).toBe(true);
  });

  it("holds ONCE, however many frames arrive", () => {
    // This runs on every frame of a streaming turn. A hold per frame would be a
    // socket per frame.
    const { c, opened } = coordinator();
    for (let i = 0; i < 500; i += 1) c.noteActivity("d1", "sprite-1");
    expect(opened).toEqual(["sprite-1"]);
    expect(c.size()).toBe(1);
  });

  it("holds each machine separately", () => {
    const { c, opened } = coordinator();
    c.noteActivity("d1", "sprite-1");
    c.noteActivity("d2", "sprite-2");
    expect(opened).toEqual(["sprite-1", "sprite-2"]);
  });
});

describe("letting go", () => {
  it("releases a machine that has gone quiet", () => {
    // The cost model rests on this. A machine that stopped working must stop
    // being paid for, or the shelf becomes a bill.
    const { c, released, tick } = coordinator();
    c.noteActivity("d1", "sprite-1");
    tick(KEEPALIVE_IDLE_MS);
    expect(c.sweep()).toEqual(["sprite-1"]);
    expect(released).toEqual(["sprite-1"]);
    expect(c.holding("d1")).toBe(false);
  });

  it("keeps holding while frames keep arriving", () => {
    // A long turn is exactly this shape: quiet stretches shorter than the idle
    // window, for as long as the work takes.
    const { c, released, tick } = coordinator();
    c.noteActivity("d1", "sprite-1");
    for (let i = 0; i < 20; i += 1) {
      tick(KEEPALIVE_IDLE_MS - 1);
      c.noteActivity("d1", "sprite-1");
      expect(c.sweep()).toEqual([]);
    }
    expect(released).toEqual([]);
    expect(c.holding("d1")).toBe(true);
  });

  it("releases immediately when the uplink goes, whatever the clock says", () => {
    // A machine whose host has disconnected is not working. Waiting out the
    // idle window would pay for ninety seconds of nothing.
    const { c, released } = coordinator();
    c.noteActivity("d1", "sprite-1");
    c.releaseFor("d1");
    expect(released).toEqual(["sprite-1"]);
    expect(c.holding("d1")).toBe(false);
  });

  it("does not fall over releasing something it never held", () => {
    const { c, released } = coordinator();
    c.releaseFor("never-seen");
    expect(released).toEqual([]);
  });

  it("survives a release that throws", () => {
    // A socket that is already gone must not strand every other hold behind it.
    let released = 0;
    let now = 0;
    const c = new KeepAliveCoordinator({
      hold: (id) => ({
        release: () => {
          released += 1;
          if (id === "boom") throw new Error("already closed");
        },
      }),
      now: () => now,
      log: () => {},
    });
    c.noteActivity("d1", "boom");
    c.noteActivity("d2", "fine");
    now += KEEPALIVE_IDLE_MS;
    expect(c.sweep().sort()).toEqual(["boom", "fine"]);
    expect(released).toBe(2);
    expect(c.size()).toBe(0);
  });

  it("releases everything on shutdown", () => {
    // Each one left behind is a machine still being billed by a relay that no
    // longer exists.
    const { c, released } = coordinator();
    c.noteActivity("d1", "sprite-1");
    c.noteActivity("d2", "sprite-2");
    c.releaseAll();
    expect(released.sort()).toEqual(["sprite-1", "sprite-2"]);
    expect(c.size()).toBe(0);
  });
});

describe("the sweeper", () => {
  it("stops cleanly", () => {
    const { c } = coordinator();
    const stop = startKeepAliveSweeper(c, 10);
    expect(() => stop()).not.toThrow();
  });
});
