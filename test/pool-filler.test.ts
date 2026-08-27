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
  it("reserves a row, creates the machine, then starts its build", async () => {
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
  it("never creates a machine it has not already reserved a row for", async () => {
    // A sprite with no row is a bill with no owner: the name is its only handle
    // and it goes out of scope. Reserving first makes that unreachable rather
    // than merely handled — if the row cannot be written, nothing is bought.
    const d = deps({ target: 1 });
    d.pool.add = async () => false;
    const out = await sweepPool(d);
    expect(out.started).toBe(0);
    expect(d.created).toEqual([]);
  });

  it("gives the slot back when the machine cannot be created", async () => {
    // Otherwise the shelf reads as fuller than it is for the whole stale
    // window, and the slot is refilled an hour late.
    const d = deps({
      target: 1,
      provisioner: {
        createNamed: async () => ({ ok: false as const, kind: "unavailable" as const }),
        destroy: async () => true,
      },
    });
    const out = await sweepPool(d);
    expect(out.started).toBe(0);
    expect(await d.pool.counts(0)).toEqual({ ready: 0, building: 0 });
  });

  it("keeps the row when the build command does not go out", async () => {
    // The machine exists and is paid for either way. The stale sweep is a
    // better place to decide it is hopeless than a catch that cannot know
    // whether the command half-ran.
    const d = deps({ target: 1, startBuild: async () => false });
    expect((await sweepPool(d)).started).toBe(1);
    expect((await d.pool.counts(0)).building).toBe(1);
  });

  it("buys nothing when the provider refuses every request", async () => {
    // Each build releases its own reservation, so a refusing provider costs a
    // sweep and leaves the shelf exactly as it was.
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
    d.pool.staleBuilds = async () => [];
    d.pool.counts = async () => { throw new Error("db down"); };
    await expect(sweepPool(d)).resolves.toEqual({ started: 0, scrapped: 0 });
  });
});

describe("filling in parallel", () => {
  it("starts them together, not one after another", async () => {
    // A machine is ready 50 seconds after it is created. Ten sequential creates
    // turned that into minutes for no benefit — they are independent.
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({
      target: 5,
      provisioner: {
        createNamed: async (name: string) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gate;
          inFlight -= 1;
          return { ok: true as const, externalId: name };
        },
        destroy: async () => true,
      },
    });
    const sweep = sweepPool(d);
    await Promise.resolve();
    release();
    expect((await sweep).started).toBe(5);
    expect(peak).toBe(5);
  });

  it("reserves every row BEFORE buying any machine", async () => {
    // The property that makes parallel safe, and the one that lets a second
    // relay instance count honestly: a slot is visible as taken the moment it
    // is claimed, not once its machine finishes being created.
    const order: string[] = [];
    const d = deps({ target: 3 });
    const add = d.pool.add.bind(d.pool);
    d.pool.add = async (id: string, secret: string) => {
      order.push(`reserve:${id}`);
      return add(id, secret);
    };
    d.provisioner.createNamed = async (name: string) => {
      order.push(`create:${name}`);
      return { ok: true as const, externalId: name };
    };
    await sweepPool(d);
    // Every reservation lands before the first machine is bought.
    const firstCreate = order.findIndex((o) => o.startsWith("create:"));
    expect(order.slice(0, firstCreate).every((o) => o.startsWith("reserve:"))).toBe(true);
    expect(order.filter((o) => o.startsWith("reserve:")).length).toBe(3);
  });

  it("does not overshoot the target when the shelf is partly full", async () => {
    const d = deps({ target: 5 });
    await d.pool.add("afkpilot-pool-existing", "s");
    const out = await sweepPool(d);
    expect(out.started).toBe(4);
    expect((await d.pool.counts(0)).building).toBe(5);
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

  it("DESTROYS the machine, not just the row", async () => {
    // Two of these were found running with nothing to show for them. A row
    // marked failed counts toward nothing, so no sweep revisits it and the
    // machine is never seen again by anything except the invoice.
    const d = deps({ target: 0, now: () => BUILD_TIMEOUT_MS });
    await d.pool.add("afkpilot-pool-dead", "s");
    await sweepPool(d);
    expect(d.destroyed).toEqual(["afkpilot-pool-dead"]);
  });

  it("leaves the row alone when the machine will not die, and retries", async () => {
    // Marking it failed here would strand the machine permanently: nothing
    // revisits a failed row. Left as `building`, the next sweep tries again.
    const d = deps({
      target: 0,
      now: () => BUILD_TIMEOUT_MS,
      provisioner: {
        createNamed: async (name: string) => ({ ok: true as const, externalId: name }),
        destroy: async () => false,
      },
    });
    await d.pool.add("afkpilot-pool-stubborn", "s");
    const out = await sweepPool(d);
    expect(out.scrapped).toBe(0);
    expect(await d.pool.staleBuilds(BUILD_TIMEOUT_MS)).toEqual(["afkpilot-pool-stubborn"]);
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
