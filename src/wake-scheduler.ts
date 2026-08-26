/**
 * Waking environments when their routines are due.
 *
 * ## Why this exists at all
 *
 * A routine on a laptop fires because the laptop is on and a human opened it.
 * A cloud environment has nobody to open it, so a daily digest scheduled for
 * 09:00 would fire whenever you next happened to visit — which is "eventually",
 * not "on time".
 *
 * Nothing is LOST without this. `routines.ts` in the extension makes catch-up
 * arithmetic: however many windows were missed while a machine slept, they
 * resolve to one key and one run, exactly as they do for a laptop that was
 * closed for a week. This sweep upgrades "when you look" to "on time", and does
 * not otherwise change routine semantics.
 *
 * ## What the relay knows, and what it must not
 *
 * One timestamp per environment. The host computes its own next due window and
 * writes `wakeAt`; the relay wakes the machine and clears it. The relay never
 * learns the cron, the routine's name, or its prompt — that would make this
 * database a payload store, which it is not.
 *
 * A woken host re-evaluates its own schedule and writes the next `wakeAt`. If
 * it does not — because it crashed, or the routine was deleted while it slept —
 * the schedule simply lapses, which is the right failure: a stale wake that
 * outlived its routine would start a machine nightly for nothing.
 */
import { dueForWake, type EnvironmentRecord } from "./environments.js";
import type { EnvironmentStore } from "./environment-store.js";
import type { WakeCoordinator } from "./environment-waker.js";

/** How often to ask. A minute is finer than any routine cadence the product
 *  offers and cheap: one indexed query against rows that have a wake set. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Most environments woken per sweep. A cap so a clock jump — or a bug that
 *  set every wake to the epoch — cannot start every machine at once. */
export const SWEEP_BATCH = 25;

export interface WakeSchedulerDeps {
  store: EnvironmentStore;
  coordinator: WakeCoordinator;
  /** Hub state, so an environment that is already up is left alone. */
  isOnline: (deviceId: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * One pass. Exported separately from the timer so it can be tested, and called
 * directly by anything that wants a sweep now.
 *
 * Returns the environments it woke, which is what the caller logs.
 */
export async function sweepDueWakes(deps: WakeSchedulerDeps): Promise<EnvironmentRecord[]> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const candidates = await deps.store.dueForWake(now, SWEEP_BATCH).catch((): EnvironmentRecord[] => []);
  // Re-filter in the pure function rather than trusting the query alone: the
  // in-memory store and Supabase must agree on what "due" means, and a rounding
  // difference between a timestamptz and epoch ms should not decide it.
  const due = dueForWake(candidates, now);
  const woken: EnvironmentRecord[] = [];

  for (const environment of due) {
    // Already up — its routine will fire on its own. Clearing the schedule here
    // is still right: the host will write the next one.
    if (deps.isOnline(environment.deviceId)) {
      await deps.store.setWakeAt(environment.deviceId, environment.userId, null).catch(() => false);
      continue;
    }
    // Cleared BEFORE the wake, not after. If the wake fails, the machine must
    // not be retried every minute for ever — a routine that missed its window
    // still catches up when the environment next comes up, because catch-up is
    // arithmetic. Retrying a failing wake on a timer is how a broken
    // environment becomes a billing incident.
    await deps.store.setWakeAt(environment.deviceId, environment.userId, null).catch(() => false);
    const outcome = await deps.coordinator.wake(environment);
    if (outcome.ok) {
      woken.push(environment);
    } else {
      log(`[env] scheduled wake for ${environment.externalId} failed: ${outcome.kind}`);
    }
  }
  if (woken.length) log(`[env] scheduled wake: ${woken.length} environment(s)`);
  return woken;
}

/**
 * Run {@link sweepDueWakes} on a timer.
 *
 * Returns a stop function. Non-overlapping by construction: the next sweep is
 * scheduled after the previous one settles, so a slow provider cannot stack
 * passes on top of each other.
 */
export function startWakeScheduler(deps: WakeSchedulerDeps & { intervalMs?: number }): () => void {
  const interval = deps.intervalMs ?? SWEEP_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await sweepDueWakes(deps);
    } catch (error) {
      (deps.log ?? (() => {}))(`[env] sweep failed: ${String((error as Error)?.message ?? error)}`);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), interval);
    timer.unref?.();
  };

  timer = setTimeout(() => void tick(), interval);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
