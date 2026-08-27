/**
 * The shelf.
 *
 * Two failure modes are worth more than the rest put together, and both are
 * about a pool quietly emptying while looking full:
 *
 *  - counting in-flight builds wrong, so a minute-by-minute sweep either starts
 *    a second wave on top of the first or never starts one at all;
 *  - believing in a dead build forever, so every sweep sees "20 building",
 *    starts nothing, and hands out nothing.
 */
import { describe, expect, it } from "vitest";
import {
  BUILD_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  MAX_BUILDS_PER_SWEEP,
  buildIsStale,
  buildsToStart,
  claimOutcome,
  isPoolSpriteName,
  parsePoolSize,
  poolSpriteName,
} from "../src/environment-pool";

describe("how many to build", () => {
  it("fills an empty shelf, a few at a time", () => {
    // Not twenty at once: twenty simultaneous creates become twenty
    // simultaneous npm installs, and a burst of failures is easier to notice
    // when it is three.
    expect(buildsToStart({ counts: { ready: 0, building: 0 }, target: 20 }))
      .toBe(MAX_BUILDS_PER_SWEEP);
  });

  it("counts builds already running toward the target", () => {
    // THE ONE THAT MATTERS. A build takes ~25 minutes and the sweep runs every
    // minute. Ignoring in-flight builds would start three more every minute for
    // twenty minutes — sixty machines for a shelf of twenty.
    expect(buildsToStart({ counts: { ready: 0, building: 20 }, target: 20 })).toBe(0);
    expect(buildsToStart({ counts: { ready: 5, building: 14 }, target: 20 })).toBe(1);
  });

  it("starts nothing when the shelf is full", () => {
    expect(buildsToStart({ counts: { ready: 20, building: 0 }, target: 20 })).toBe(0);
    expect(buildsToStart({ counts: { ready: 25, building: 0 }, target: 20 })).toBe(0);
  });

  it("starts nothing when there is no pool", () => {
    // Target zero is the default and means the feature is off. It must not
    // build "just one".
    expect(buildsToStart({ counts: { ready: 0, building: 0 }, target: 0 })).toBe(0);
  });

  it("treats nonsense counts as zero rather than as negative work", () => {
    expect(buildsToStart({ counts: { ready: -3, building: -2 }, target: 2 })).toBe(2);
  });

  it("honours a smaller per-sweep cap", () => {
    expect(buildsToStart({ counts: { ready: 0, building: 0 }, target: 20, maxPerSweep: 1 }))
      .toBe(1);
  });
});

describe("giving up on a build", () => {
  it("keeps believing well past the measured happy path", () => {
    // 25 minutes was the real end-to-end install. Failing a build at 30 would
    // strand machines that were about to be useful.
    const thirtyMin = 30 * 60_000;
    expect(buildIsStale({ startedAt: 0, now: thirtyMin })).toBe(false);
  });

  it("stops counting one that is clearly gone", () => {
    expect(buildIsStale({ startedAt: 0, now: BUILD_TIMEOUT_MS })).toBe(true);
    expect(buildIsStale({ startedAt: 0, now: BUILD_TIMEOUT_MS + 1 })).toBe(true);
  });
});

describe("the size parameter", () => {
  it("is off unless somebody sets it", () => {
    // Turning a pool on provisions real machines that cost real money. That
    // happens because a number was set, never because a deploy inherited one.
    expect(parsePoolSize(undefined)).toBe(0);
    expect(parsePoolSize("")).toBe(0);
    expect(parsePoolSize("   ")).toBe(0);
  });

  it("reads a number", () => {
    expect(parsePoolSize("20")).toBe(DEFAULT_POOL_SIZE);
    expect(parsePoolSize("3")).toBe(3);
    expect(parsePoolSize("0")).toBe(0);
  });

  it("refuses nonsense rather than guessing", () => {
    expect(parsePoolSize("-5")).toBe(0);
    expect(parsePoolSize("banana")).toBe(0);
    expect(parsePoolSize("Infinity")).toBe(0);
  });
});

describe("naming", () => {
  it("marks a machine as being on the shelf", () => {
    // An operator looking at a list of sprites can tell which ones somebody is
    // using and which are spares. The per-user names are a one-way hash.
    const name = poolSpriteName(() => "abcdef0123456789");
    expect(name).toBe("afkpilot-pool-abcdef012345");
    expect(isPoolSpriteName(name)).toBe(true);
  });

  it("survives a uuid with dashes in it", () => {
    const name = poolSpriteName(() => "3f2a-91bc-77de-4401");
    expect(name).toMatch(/^afkpilot-pool-[0-9a-f]{12}$/);
  });

  it("does not mistake a user's environment for a spare", () => {
    // The two live in the same org and a pool sweep must never touch one that
    // belongs to somebody.
    expect(isPoolSpriteName("afkpilot-u-984b42746396")).toBe(false);
    expect(isPoolSpriteName("afkpilot-probe")).toBe(false);
  });
});

describe("what an open does with the shelf", () => {
  it("takes the machine it was handed", () => {
    expect(claimOutcome({ externalId: "afkpilot-pool-aaa" }))
      .toEqual({ ok: true, externalId: "afkpilot-pool-aaa", fromPool: true });
  });

  it("treats an empty shelf as the on-demand path, not as a failure", () => {
    // Nothing to hand out is exactly the situation before any pool existed, and
    // that path still works. Reporting it as an error would turn a slow open
    // into a broken one.
    expect(claimOutcome(null)).toEqual({ ok: false, reason: "empty" });
  });
});
