/**
 * Waking environments for their routines.
 *
 * The load-bearing decision here is that a failed scheduled wake is NOT
 * retried. Catch-up is arithmetic in the extension — a missed window resolves
 * to one run whenever the machine next comes up — so retrying costs money and
 * buys nothing, and a permanently broken environment retried every minute is a
 * billing incident rather than a bug report.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InMemoryEnvironmentStore } from "../src/environment-store";
import { WakeCoordinator } from "../src/environment-waker";
import {
  SWEEP_BATCH,
  sweepDueWakes,
  startWakeScheduler,
} from "../src/wake-scheduler";

const NOW = 1_700_000_000_000;

async function seed(count: number, wakeAt: (i: number) => number | null) {
  const store = new InMemoryEnvironmentStore(() => NOW);
  for (let i = 0; i < count; i += 1) {
    await store.create({ deviceId: `d${i}`, userId: "u1", provider: "sprite", externalId: `s${i}` });
    await store.setWakeAt(`d${i}`, "u1", wakeAt(i));
  }
  return store;
}

function harness(opts: { online?: string[]; ok?: boolean } = {}) {
  const online = new Set(opts.online ?? []);
  const woken: string[] = [];
  const coordinator = new WakeCoordinator({
    wake: async (e) => {
      woken.push(e.deviceId);
      return opts.ok === false ? { ok: false, kind: "unavailable" } : { ok: true };
    },
  });
  return { coordinator, woken, isOnline: (id: string) => online.has(id) };
}

describe("sweeping due wakes", () => {
  it("wakes an environment whose scheduled time has passed", async () => {
    const store = await seed(1, () => NOW - 1_000);
    const h = harness();
    const woken = await sweepDueWakes({ store, ...h, now: () => NOW });
    expect(woken.map((e) => e.deviceId)).toEqual(["d0"]);
    expect(h.woken).toEqual(["d0"]);
  });

  it("leaves alone anything not yet due", async () => {
    const store = await seed(1, () => NOW + 60_000);
    const h = harness();
    expect(await sweepDueWakes({ store, ...h, now: () => NOW })).toEqual([]);
    expect(h.woken).toEqual([]);
    // And the schedule survives — clearing it would silently drop the routine.
    expect((await store.find("d0"))?.wakeAt).toBe(NOW + 60_000);
  });

  it("ignores environments with nothing scheduled", async () => {
    const store = await seed(2, () => null);
    const h = harness();
    expect(await sweepDueWakes({ store, ...h, now: () => NOW })).toEqual([]);
  });

  it("does not wake one that is already up, but does clear its schedule", async () => {
    // Its routine fires on its own; the host writes the next wakeAt.
    const store = await seed(1, () => NOW - 1_000);
    const h = harness({ online: ["d0"] });
    expect(await sweepDueWakes({ store, ...h, now: () => NOW })).toEqual([]);
    expect(h.woken).toEqual([]);
    expect((await store.find("d0"))?.wakeAt).toBeNull();
  });

  it("clears the schedule so a failing wake is not retried every minute", async () => {
    const store = await seed(1, () => NOW - 1_000);
    const h = harness({ ok: false });
    await sweepDueWakes({ store, ...h, now: () => NOW });
    expect(h.woken).toEqual(["d0"]);
    expect((await store.find("d0"))?.wakeAt).toBeNull();

    // A second sweep must do nothing. Catch-up is arithmetic: the missed window
    // still runs when the environment next comes up.
    const second = await sweepDueWakes({ store, ...h, now: () => NOW + 60_000 });
    expect(second).toEqual([]);
    expect(h.woken).toEqual(["d0"]);
  });

  it("caps how many it wakes at once", async () => {
    // A clock jump, or a bug setting every wake to the epoch, must not start
    // every machine in the fleet on one tick.
    const store = await seed(SWEEP_BATCH + 10, () => NOW - 1_000);
    const h = harness();
    const woken = await sweepDueWakes({ store, ...h, now: () => NOW });
    expect(woken.length).toBe(SWEEP_BATCH);
  });

  it("survives a store that throws", async () => {
    const store = new InMemoryEnvironmentStore(() => NOW);
    store.dueForWake = async () => { throw new Error("db down"); };
    const h = harness();
    expect(await sweepDueWakes({ store, ...h, now: () => NOW })).toEqual([]);
  });
});

describe("the timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps on an interval and stops when told", async () => {
    const store = await seed(1, () => NOW - 1_000);
    const h = harness();
    const stop = startWakeScheduler({ store, ...h, now: () => NOW, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.woken).toEqual(["d0"]);
    stop();
    await store.setWakeAt("d0", "u1", NOW - 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.woken).toEqual(["d0"]);
  });

  it("does not stack passes when one runs long", async () => {
    // The next sweep is scheduled after the previous settles, so a slow provider
    // cannot pile sweeps on top of each other.
    let inFlight = 0;
    let maxConcurrent = 0;
    const store = await seed(1, () => NOW - 1_000);
    const coordinator = new WakeCoordinator({
      wake: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 500));
        inFlight -= 1;
        return { ok: true };
      },
    });
    const stop = startWakeScheduler({
      store, coordinator, isOnline: () => false, now: () => NOW, intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    stop();
    expect(maxConcurrent).toBe(1);
  });
});
