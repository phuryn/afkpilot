/**
 * The filler.
 *
 * Every test here is about a way the shelf can be wrong while the numbers look
 * right: a machine created but never recorded, a row recorded for a machine
 * that was never created, a dead build holding a slot forever, or a sweep that
 * doubles the shelf by overlapping the previous one.
 */
import { describe, expect, it, vi } from "vitest";
import { sweepPool, startPoolFiller, type PoolFillerDeps } from "../src/pool-filler";
import { InMemoryEnvironmentPoolStore } from "../src/environment-pool-store";
import { BUILD_TIMEOUT_MS, MAX_BUILDS_PER_SWEEP } from "../src/environment-pool";

function deps(over: Partial<PoolFillerDeps> = {}): PoolFillerDeps & {
  created: string[];
  destroyed: string[];
  builds: string[];
  pool: InMemoryEnvironmentPoolStore;
} {
  const created: string[] = [];
  const destroyed: string[] = [];
  const builds: string[] = [];
  let n = 0;
  const pool = new InMemoryEnvironmentPoolStore(() => 0);
  return {
    pool,
    created, destroyed, builds,
    provisioner: {
      createNamed: async (name: string) => { created.push(name); return { ok: true as const, externalId: name }; },
      destroy: async (id: string) => { destroyed.push(id); return true; },
    },
    startBuild: async (id: string) => { builds.push(id); return true; },
    target: 5,
    now: () => 0,
    // Hex only, and distinct per call. A previous version prefixed these with
    // letters that `poolSpriteName` strips, so every name came out identical
    // and the filler destroyed its own machines as duplicates — correct
    // behaviour, useless fixture.
    randomId: () => (n += 1).toString(16).padStart(12, "0"),
    log: () => {},
    ...over,
  };
}

describe("filling", () => {
  it("creates, records, and starts a build — in that order", async () => {
    const d = deps({ target: 1 });
    const out = await sweepPool(d);
    expect(out.started).toBe(1);
    expect(d.created.length).toBe(1);
    expect(d.builds).toEqual(d.created);
    expect((await d.pool.counts(0)).building).toBe(1);
  });

  it("names pooled machines so an operator can tell them apart", async () => {
    const d = deps({ target: 1 });
    await sweepPool(d);
    expect(d.created[0]).toMatch(/^afkpilot-pool-[0-9a-f]{12}$/);
  });

  it("builds a few at a time, not the whole shelf at once", async () => {
    const d = deps({ target: 20 });
    expect((await sweepPool(d)).started).toBe(MAX_BUILDS_PER_SWEEP);
  });

  it("stops building once the shelf is full", async () => {
    const d = deps({ target: 1 });
    await sweepPool(d);
    expect((await sweepPool(d)).started).toBe(0);
    expect(d.created.length).toBe(1);
  });

  it("does nothing at all when the pool is switched off", async () => {
    const d = deps({ target: 0 });
    await sweepPool(d);
    expect(d.created).toEqual([]);
  });
});

describe("when things go wrong", () => {
  it("destroys a machine it could not record, rather than orphaning it", async () => {
    // A sprite with no row is a bill with no owner: the name was the only
    // handle on it and it just went out of scope.
    const d = deps({ target: 1 });
    d.pool.add = async () => false;
    const out = await sweepPool(d);
    expect(out.started).toBe(0);
    expect(d.destroyed).toEqual(d.created);
  });

  it("keeps the row when the build command does not go out", async () => {
    // The machine exists and is paid for either way. `failStale` is a better
    // place to decide it is hopeless than a catch that cannot know whether the
    // command half-ran.
    const d = deps({ target: 1, startBuild: async () => false });
    expect((await sweepPool(d)).started).toBe(1);
    expect((await d.pool.counts(0)).building).toBe(1);
  });

  it("stops the sweep when the provider refuses, instead of collecting refusals", async () => {
    const d = deps({
      target: 20,
      provisioner: {
        createNamed: async () => ({ ok: false as const, kind: "quota" as const }),
        destroy: async () => true,
      },
    });
    expect((await sweepPool(d)).started).toBe(0);
  });

  it("survives the store being unreachable", async () => {
    const d = deps({ target: 5 });
    d.pool.counts = async () => { throw new Error("db down"); };
    await expect(sweepPool(d)).resolves.toEqual({ started: 0, scrapped: 0 });
  });
});

describe("scrapping dead builds", () => {
  it("frees the slot in the SAME pass that refills it", async () => {
    // The failure this prevents: a shelf that reads as full forever because
    // every slot is held by a build that died. Scrapping in a later pass would
    // still work eventually — but only if the pass that counts runs after it,
    // which is exactly what is not guaranteed.
    const d = deps({ target: 1, now: () => BUILD_TIMEOUT_MS });
    await d.pool.add("afkpilot-pool-dead", "s");
    const out = await sweepPool(d);
    expect(out.scrapped).toBe(1);
    expect(out.started).toBe(1);
  });

  it("leaves a build that is merely slow", async () => {
    const d = deps({ target: 1, now: () => BUILD_TIMEOUT_MS - 1 });
    await d.pool.add("afkpilot-pool-slow", "s");
    const out = await sweepPool(d);
    expect(out.scrapped).toBe(0);
    expect(out.started).toBe(0);
  });
});

describe("the timer", () => {
  it("never runs two sweeps at once", async () => {
    // Twenty creates against a slow provider can outlast the interval.
    // Overlapping sweeps would each see the same empty shelf and each fill it.
    vi.useFakeTimers();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const d = deps({
        target: 1,
        provisioner: {
          createNamed: async (name: string) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await gate;
            inFlight -= 1;
            return { ok: true as const, externalId: name };
          },
          destroy: async () => true,
        },
      });
      const stop = startPoolFiller({ ...d, intervalMs: 10 });
      await vi.advanceTimersByTimeAsync(35);
      release();
      await vi.advanceTimersByTimeAsync(10);
      stop();
      expect(maxInFlight).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not sweep the instant the relay starts", async () => {
    // A relay that has just booted is the worst moment to make twenty provider
    // calls, and a shelf being filled ahead of demand has time.
    vi.useFakeTimers();
    try {
      const d = deps({ target: 5 });
      const stop = startPoolFiller({ ...d, intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(d.created).toEqual([]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
