/**
 * The shelf's bookkeeping.
 *
 * The property everything else rests on: a machine is handed to ONE person.
 * Everything below either pins that or pins something that would quietly break
 * it — a readiness report that can be replayed, a stale build that keeps its
 * slot forever, a claimed row that wanders back onto the shelf.
 */
import { describe, expect, it } from "vitest";
import { InMemoryEnvironmentPoolStore } from "../src/environment-pool-store";
import { BUILD_TIMEOUT_MS } from "../src/environment-pool";

const SECRET = "s3cr3t";

function store(now = () => 1_000_000) {
  return new InMemoryEnvironmentPoolStore(now);
}

async function readyOne(s: InMemoryEnvironmentPoolStore, name: string, at = 1_000_000) {
  await s.add(name, SECRET);
  await s.markReady(name, SECRET, at);
}

describe("claiming", () => {
  it("hands the same machine to exactly one caller", async () => {
    // THE INVARIANT. Two opens racing on a shelf of one: one wins, the other is
    // told the shelf is empty and takes the on-demand path. Nobody gets a
    // machine somebody else is already on.
    const s = store();
    await readyOne(s, "afkpilot-pool-a");

    const [first, second] = await Promise.all([s.claim(), s.claim()]);
    const got = [first, second].filter(Boolean);
    expect(got.length).toBe(1);
    expect(got[0]!.externalId).toBe("afkpilot-pool-a");
  });

  it("gives out the machine that has waited longest", async () => {
    // Otherwise a shelf that is never fully drained keeps its oldest builds
    // forever while cycling the newest.
    const s = store();
    await readyOne(s, "afkpilot-pool-old", 1_000);
    await readyOne(s, "afkpilot-pool-new", 9_000);
    expect((await s.claim())?.externalId).toBe("afkpilot-pool-old");
  });

  it("returns nothing from an empty shelf", async () => {
    expect(await store().claim()).toBeNull();
  });

  it("never hands out a machine that is still building", async () => {
    const s = store();
    await s.add("afkpilot-pool-b", SECRET);
    expect(await s.claim()).toBeNull();
  });

  it("does not hand out the same machine twice in sequence", async () => {
    const s = store();
    await readyOne(s, "afkpilot-pool-a");
    expect(await s.claim()).not.toBeNull();
    expect(await s.claim()).toBeNull();
  });
});

describe("a sprite reporting itself ready", () => {
  it("accepts the report with the right secret", async () => {
    const s = store();
    await s.add("afkpilot-pool-a", SECRET);
    expect(await s.markReady("afkpilot-pool-a", SECRET, 2_000)).toBe(true);
    expect((await s.counts(2_000)).ready).toBe(1);
  });

  it("refuses one without it", async () => {
    // A ~25-minute install is not something the relay sits and watches, so
    // `ready` is a claim the machine makes. Without the secret, guessing a name
    // would put a half-built box in front of a user.
    const s = store();
    await s.add("afkpilot-pool-a", SECRET);
    expect(await s.markReady("afkpilot-pool-a", "wrong", 2_000)).toBe(false);
    expect((await s.counts(2_000)).ready).toBe(0);
  });

  it("refuses one for a machine nobody built", async () => {
    expect(await store().markReady("afkpilot-pool-ghost", SECRET, 2_000)).toBe(false);
  });

  it("cannot put a claimed machine back on the shelf", async () => {
    // A replayed report while somebody is using it would offer their
    // environment to the next person who opens one.
    const s = store();
    await readyOne(s, "afkpilot-pool-a");
    await s.claim();
    expect(await s.markReady("afkpilot-pool-a", SECRET, 3_000)).toBe(false);
    expect(await s.claim()).toBeNull();
  });
});

describe("counting", () => {
  it("separates what is ready from what is on its way", async () => {
    const s = store();
    await readyOne(s, "afkpilot-pool-a");
    await s.add("afkpilot-pool-b", SECRET);
    expect(await s.counts(1_000_000)).toEqual({ ready: 1, building: 1 });
  });

  it("stops counting a build that is past believing in", async () => {
    // A pool empties quietly this way: every sweep sees the target already met
    // by builds that will never finish, starts nothing, and hands out nothing.
    const s = store(() => 0);
    await s.add("afkpilot-pool-b", SECRET);
    expect((await s.counts(BUILD_TIMEOUT_MS - 1)).building).toBe(1);
    expect((await s.counts(BUILD_TIMEOUT_MS)).building).toBe(0);
  });

  it("does not count a claimed machine as stock", async () => {
    const s = store();
    await readyOne(s, "afkpilot-pool-a");
    await s.claim();
    expect(await s.counts(1_000_000)).toEqual({ ready: 0, building: 0 });
  });
});

describe("scrapping stale builds", () => {
  it("NAMES them without burying them", async () => {
    // Naming and burying are separate because a scrapped build still has a
    // machine behind it. Marking the row first means no later sweep ever looks
    // at it again — the row counts toward nothing — and the bill runs forever.
    const s = store(() => 0);
    await s.add("afkpilot-pool-b", SECRET);
    expect(await s.staleBuilds(BUILD_TIMEOUT_MS)).toEqual(["afkpilot-pool-b"]);
    // Still building until somebody buries it.
    expect((await s.counts(BUILD_TIMEOUT_MS - 1)).building).toBe(1);
  });

  it("buries one on request", async () => {
    const s = store(() => 0);
    await s.add("afkpilot-pool-b", SECRET);
    expect(await s.markFailed("afkpilot-pool-b", "gone")).toBe(true);
    expect((await s.counts(0)).building).toBe(0);
  });

  it("will not bury a machine somebody is already using", async () => {
    const s = store(() => 0);
    await readyOne(s, "afkpilot-pool-a", 0);
    await s.claim();
    expect(await s.markFailed("afkpilot-pool-a", "gone")).toBe(false);
  });

  it("leaves a build that is merely slow alone", async () => {
    const s = store(() => 0);
    await s.add("afkpilot-pool-b", SECRET);
    expect(await s.staleBuilds(BUILD_TIMEOUT_MS - 1)).toEqual([]);
  });

  it("does not touch one that already reported ready", async () => {
    const s = store(() => 0);
    await readyOne(s, "afkpilot-pool-a", 0);
    expect(await s.staleBuilds(BUILD_TIMEOUT_MS)).toEqual([]);
    expect((await s.counts(BUILD_TIMEOUT_MS)).ready).toBe(1);
  });
});

describe("adding", () => {
  it("refuses a duplicate name rather than losing the first row", async () => {
    const s = store();
    expect(await s.add("afkpilot-pool-a", SECRET)).toBe(true);
    expect(await s.add("afkpilot-pool-a", "other")).toBe(false);
  });
});
