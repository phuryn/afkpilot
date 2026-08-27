/**
 * What the cloud row says it is.
 *
 * This is the whole of what somebody sees before they have a working machine,
 * and the distinction that matters most is the one that did not exist until
 * now: a machine BEING BUILT is not a machine that is switched off. Showing
 * "offline" for the twenty-five minutes of a first build is how a product that
 * is working perfectly reads as broken.
 */
import { describe, expect, it } from "vitest";
import { buildElapsedMs, cloudRowState, type EnvironmentRecord } from "../src/environments";

function env(over: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    deviceId: "d1",
    userId: "u1",
    provider: "sprite",
    externalId: "afkpilot-u-abc",
    wakeAt: null,
    readyAt: 5_000,
    createdAt: 1_000,
    ...over,
  };
}

describe("before there is a machine", () => {
  it("offers to make one", () => {
    expect(cloudRowState({ entitled: true })).toBe("not-provisioned");
    expect(cloudRowState({ entitled: true, environment: null })).toBe("not-provisioned");
  });

  it("offers an upgrade instead when the plan does not include it", () => {
    expect(cloudRowState({ entitled: false })).toBe("upgrade");
  });
});

describe("while one is being built", () => {
  it("says so, rather than saying offline", () => {
    // THE POINT OF THE STATE. A row that has never linked is under
    // construction. The person watching it just asked for it to be made.
    expect(cloudRowState({ entitled: true, environment: env({ readyAt: null }) }))
      .toBe("building");
  });

  it("counts up from when the machine was asked for", () => {
    expect(buildElapsedMs({ environment: env({ createdAt: 1_000 }), now: 61_000 })).toBe(60_000);
  });

  it("never counts backwards, whatever the clocks say", () => {
    // Database time and relay time are different clocks. A row created "in the
    // future" must show 0, not a countdown.
    expect(buildElapsedMs({ environment: env({ createdAt: 9_000 }), now: 1_000 })).toBe(0);
  });
});

describe("once it has linked", () => {
  it("is ready, and stays ready after it goes to sleep", () => {
    // readyAt answers "has this ever worked", not "is it up now". A paused
    // machine is ready-and-offline, which the picker already knows how to say —
    // and must NOT fall back into looking like a fresh build.
    expect(cloudRowState({ entitled: true, environment: env({ readyAt: 5_000 }) }))
      .toBe("ready");
  });

  it("still shows an upgrade if the plan lapsed", () => {
    // Entitlement is checked first and checked even when a machine exists.
    // Cold storage is pennies; compute is not.
    expect(cloudRowState({ entitled: false, environment: env() })).toBe("upgrade");
    expect(cloudRowState({ entitled: false, environment: env({ readyAt: null }) })).toBe("upgrade");
  });
});
