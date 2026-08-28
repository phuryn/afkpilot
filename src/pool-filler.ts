/**
 * Keeping the shelf stocked.
 *
 * The impure half of `environment-pool.ts`: a timer, some provider calls, and
 * the decisions imported from there. Same split as `wake-scheduler.ts` beside
 * `environments.ts`, for the same reason — a loop that talks to a provider is
 * not something you want to unit-test, and the arithmetic is not something you
 * want to leave untested.
 *
 * ## The row comes first, and that is what makes concurrency safe
 *
 * A build RESERVES its slot before the machine exists: the row is written, then
 * the sprite is created. Anything else counting the shelf — a parallel build in
 * this same sweep, a second relay instance, the next sweep — sees the
 * reservation immediately and does not build a duplicate for it.
 *
 * The older order (create, then record) was chosen to avoid a row with no
 * machine. That trade is the wrong way round: a row with no machine is
 * self-healing, because the stale sweep destroys it and a destroy of something
 * that never existed is a 404, which counts as destroyed. A machine with no row
 * heals never — the name was its only handle and it went out of scope.
 *
 * ## Builds run in parallel
 *
 * A machine is ready 50 seconds after it is created. Starting ten one at a time
 * turned that into minutes for no benefit; they are independent, so they go
 * together.
 *
 * ## Nothing here watches a build, but something has to keep it ALIVE
 *
 * Starting one is a command whose exit code the filler DOES see — it registers
 * a service — but the install that service then performs takes minutes, and
 * watching it over a socket is a bet against the network. So the filler starts
 * a build and forgets it; the machine reports its own readiness later.
 * `failStale` exists because from out here "still building" and "died twenty
 * minutes ago" look identical.
 *
 * Forgetting it entirely, however, was a bug that hid inside a plausible story.
 * A sprite suspends about a minute after the last EXTERNAL interaction, and a
 * machine installing itself is not interacting with anything — so it froze
 * mid-install, with its own log ending part-way through a line and its install
 * directory empty. Measured 2026-08-28 on `afkpilot-pool-7ba8da874277`:
 *
 *     [23:48:41] install: looking for a published Linux build (t+41s)
 *     …nothing further, 31 minutes later, status `cold`
 *
 * That is why roughly half of every batch "stalled downloading": the ones that
 * finished were the ones that happened to finish inside a minute. So the filler
 * now HOLDS each building machine awake — the same mechanism that keeps a
 * working machine awake for a turn — and lets go the moment the row stops
 * saying `building`, whether that is because it went ready or because it was
 * scrapped.
 */
import {
  FILL_INTERVAL_MS,
  buildsToStart,
  poolSpriteName,
} from "./environment-pool.js";
import type { EnvironmentPoolStore } from "./environment-pool-store.js";
import type { EnvironmentProvisioner } from "./environment-provisioner.js";

export interface PoolFillerDeps {
  pool: EnvironmentPoolStore;
  provisioner: Pick<EnvironmentProvisioner, "createNamed" | "destroy">;
  /**
   * Start the install on a freshly created machine.
   *
   * `true` means the installer was successfully SET UP — never that the install
   * finished. The machine says that later, when it reports ready.
   */
  startBuild(externalId: string, claimSecret: string): Promise<boolean>;
  /**
   * Keep a machine running while it installs itself.
   *
   * Optional: without it the filler behaves as it did, which is to say builds
   * longer than about a minute freeze. Present in production, absent in the
   * unit tests that only care about the arithmetic.
   */
  hold?(externalId: string): { release(): void };
  /**
   * The holds currently open, keyed by machine.
   *
   * Lives on the deps rather than in a lookup keyed by them, so that spreading
   * `{...deps, now}` — which the tests and any future caller will do — carries
   * the same holds rather than silently starting a fresh, leaking set.
   * `startPoolFiller` creates one; call `sweepPool` directly and you own it.
   */
  holds?: Map<string, { release(): void }>;
  /** See {@link failedLaunches}. Created on first use; carried by a spread. */
  failedLaunches?: Set<string>;
  target: number;
  now: () => number;
  randomId: () => string;
  log?: (line: string) => void;
}

export interface SweepResult {
  started: number;
  scrapped: number;
}

/**
 * One pass: scrap what is dead, then build up to the target.
 *
 * Scrapping FIRST, in the same pass, because a stale build still occupies a
 * slot in the count. Doing it after would mean every sweep sees the target met
 * by machines that will never arrive, starts nothing, and the shelf empties
 * while the numbers say it is full.
 *
 * And scrapping means DESTROYING, not just relabelling. A row marked failed
 * still has a machine behind it; since a failed row counts toward nothing, no
 * later sweep would ever look at it again and the bill would run forever. Two
 * of those existed before this was written.
 */
/**
 * Machines whose build command never went out.
 *
 * Their rows still say `building` — deliberately, so the stale sweep destroys
 * them — but nothing is installing behind them, so they must not be adopted and
 * held awake. Lives on the deps beside `holds`, and for the same reason: a
 * lookup keyed by the deps object silently starts fresh when somebody writes
 * `{...deps, now}`, which is how the first version of `holds` leaked.
 */
function failedLaunches(deps: PoolFillerDeps): Set<string> {
  if (!deps.failedLaunches) deps.failedLaunches = new Set();
  return deps.failedLaunches;
}

/** Let go of everything this filler is holding. Used when it stops. */
export function releasePoolHolds(deps: PoolFillerDeps): void {
  const holds = deps.holds;
  if (!holds) return;
  for (const [id, h] of holds) {
    holds.delete(id);
    try { h.release(); } catch { /* the socket is going either way */ }
  }
}

export async function sweepPool(deps: PoolFillerDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now();
  const holds = deps.holds;

  // Let go of anything that is no longer building. A machine that went ready is
  // finished with us; one that was scrapped no longer exists. Either way a hold
  // on it is a socket reconnecting for ever against something nobody wants.
  if (holds && deps.hold) {
    // ADOPT, then let go. Adoption is the half that is easy to miss and the
    // half that matters most: a deploy or a crash takes this process's hold
    // sockets with it, and the replacement starts with an empty map. Without
    // adopting the rows that were already building, every install in flight
    // across a deploy freezes about a minute later and stays frozen until the
    // stale sweep destroys it an hour on — which is exactly the failure this
    // whole mechanism exists to prevent, and deploys are when it is most
    // likely to happen.
    let building: string[] | null = null;
    try {
      building = await deps.pool.building();
    } catch {
      // "Nobody is building" is what a failed query says, and acting on it
      // would drop every hold at once. Keep what we have and try next sweep.
      building = null;
    }
    if (building) {
      const stillBuilding = new Set(building);
      const bad = failedLaunches(deps);
      for (const id of stillBuilding) {
        // Not the ones whose build command never went out: those rows say
        // `building` and nothing is installing behind them.
        if (holds.has(id) || bad.has(id)) continue;
        try {
          holds.set(id, deps.hold(id));
          log(`[pool] adopted ${id}; holding it awake`);
        } catch { /* it still gets the old, worse odds */ }
      }
      for (const [id, h] of holds) {
        if (stillBuilding.has(id)) continue;
        holds.delete(id);
        try { h.release(); } catch { /* already gone */ }
      }
    }
  }

  let scrapped = 0;
  for (const id of await deps.pool.staleBuilds(now).catch(() => [])) {
    // Destroy BEFORE marking. A destroy that fails leaves the row `building`,
    // so the next sweep tries again — which is what makes this self-healing
    // rather than a leak that needs somebody to notice it.
    const gone = await deps.provisioner.destroy(id).catch(() => false);
    if (!gone) {
      log(`[pool] ${id} never reported ready and could not be destroyed; will retry`);
      continue;
    }
    await deps.pool.markFailed(id, "build never reported ready; machine destroyed")
      .catch(() => false);
    // Released HERE, not on the next sweep's tidy-up: the machine has just been
    // destroyed, so a hold on it is a socket reconnecting for ever against
    // something that no longer exists.
    const h = holds?.get(id);
    if (h) {
      holds!.delete(id);
      try { h.release(); } catch { /* already gone */ }
    }
    scrapped += 1;
  }
  if (scrapped > 0) log(`[pool] scrapped ${scrapped} build(s) that never reported ready`);

  const counts = await deps.pool.counts(now).catch(() => null);
  if (!counts) return { started: 0, scrapped };

  const want = buildsToStart({ counts, target: deps.target });
  if (want === 0) return { started: 0, scrapped };

  const outcomes = await Promise.all(
    Array.from({ length: want }, async () => {
      const name = poolSpriteName(deps.randomId);
      const secret = deps.randomId();

      // RESERVE FIRST. The row is the thing everything else counts, so writing
      // it before the machine exists is what stops two builders — parallel
      // here, or a second relay instance — from filling the same slot twice.
      const reserved = await deps.pool.add(name, secret).catch(() => false);
      if (!reserved) return false; // name already taken; vanishingly rare

      const made = await deps.provisioner.createNamed(name).catch(() => null);
      if (!made || !made.ok) {
        // Give the slot back rather than leaving a reservation for a machine
        // that will never arrive; otherwise the shelf reads as fuller than it is
        // for the whole stale window.
        log(`[pool] create failed (${made ? made.kind : "unavailable"}); releasing ${name}`);
        await deps.pool.remove(name).catch(() => false);
        return false;
      }

      // BEFORE the build, not after: the install begins the moment the command
      // lands, and the machine can suspend inside the first minute of it.
      if (deps.hold && holds && !holds.has(made.externalId)) {
        try {
          holds.set(made.externalId, deps.hold(made.externalId));
        } catch {
          // A machine that cannot be held still gets built; it just gets the
          // old, worse odds. Failing the whole sweep over it would be worse.
        }
      }

      const kicked = await deps.startBuild(made.externalId, secret).catch(() => false);
      if (!kicked) {
        // The row stays. The machine exists and is paid for either way, and the
        // stale sweep is a better place to decide it is hopeless than a `catch`
        // that has no idea whether the command half-ran.
        log(`[pool] ${made.externalId} created but the build command did not go out`);
        // But STOP HOLDING IT. Nothing is installing, so the hold would keep a
        // machine running and billing for the full hour until the stale sweep
        // reached it — and if the failure is systematic, that is the entire
        // pool target burning at once. Remembered, not just released, because
        // the row is still `building` and adoption would otherwise pick it
        // straight back up on the next sweep.
        failedLaunches(deps).add(made.externalId);
        const h = holds?.get(made.externalId);
        if (h) {
          holds!.delete(made.externalId);
          try { h.release(); } catch { /* already gone */ }
        }
      }
      return true;
    }),
  );

  const started = outcomes.filter(Boolean).length;
  if (started > 0) {
    log(`[pool] started ${started} build(s); ${counts.ready} ready, ${counts.building} in flight`);
  }
  return { started, scrapped };
}

/**
 * Run the sweep on a timer.
 *
 * Returns its own stopper. The first sweep is deferred rather than immediate:
 * a relay that has just started is the least good moment to make twenty
 * provider calls, and the shelf is being filled ahead of demand — it has time.
 */
export function startPoolFiller(
  deps: PoolFillerDeps & { intervalMs?: number },
): () => void {
  const every = deps.intervalMs ?? FILL_INTERVAL_MS;
  // One set of holds for this filler's whole life, shared by every sweep.
  if (!deps.holds) deps.holds = new Map();
  let running = false;
  const tick = async () => {
    // A sweep can outlive its interval — twenty creates against a slow provider
    // is not fast. Overlapping them would double the shelf.
    if (running) return;
    running = true;
    try {
      await sweepPool(deps);
    } catch (e) {
      (deps.log ?? (() => {}))(`[pool] sweep failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, every);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    // The stopper owns the holds it opened. Leaving them would mean a relay
    // that has shut down still paying to keep machines awake.
    releasePoolHolds(deps);
  };
}
