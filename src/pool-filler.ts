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
 * ## Nothing here watches a build
 *
 * Starting one is a command whose exit code the filler DOES see — it registers
 * a service — but the install that service then performs takes ~25 minutes, and
 * holding a socket open for that is a bet against the network. So the filler
 * starts a build and forgets it; the machine reports its own readiness later.
 * `failStale` exists because from out here "still building" and "died twenty
 * minutes ago" look identical.
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
export async function sweepPool(deps: PoolFillerDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now();

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

      const kicked = await deps.startBuild(made.externalId, secret).catch(() => false);
      if (!kicked) {
        // The row stays. The machine exists and is paid for either way, and the
        // stale sweep is a better place to decide it is hopeless than a `catch`
        // that has no idea whether the command half-ran.
        log(`[pool] ${made.externalId} created but the build command did not go out`);
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
  return () => clearInterval(timer);
}
