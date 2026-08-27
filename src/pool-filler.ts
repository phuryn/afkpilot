/**
 * Keeping the shelf stocked.
 *
 * The impure half of `environment-pool.ts`: a timer, some provider calls, and
 * the decisions imported from there. Same split as `wake-scheduler.ts` beside
 * `environments.ts`, for the same reason — a loop that talks to a provider is
 * not something you want to unit-test, and the arithmetic is not something you
 * want to leave untested.
 *
 * ## The order of operations matters
 *
 * A machine is created BEFORE its row is written, and its row is written before
 * anyone is told it exists. Get that backwards and you have a sprite nobody has
 * a record of — a bill with no owner and no way to find it, since the name is
 * the only handle and it lived in a variable that has gone out of scope.
 *
 * ## Nothing here reads the sprite
 *
 * `POST /v1/sprites/{name}/exec` over HTTP returns two bytes: no output, no
 * exit code. The filler therefore cannot watch a build. It starts one and
 * forgets it; the machine reports its own readiness later. Everything about
 * this module follows from that — including `failStale`, which exists purely
 * because "still building" and "died twenty minutes ago" look identical from
 * out here.
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
   * Fire and forget by nature, so a `true` here means "the provider accepted
   * the command", never "the install worked". The machine says that later.
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
 */
export async function sweepPool(deps: PoolFillerDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now();

  const scrapped = await deps.pool.failStale(now).catch(() => 0);
  if (scrapped > 0) log(`[pool] scrapped ${scrapped} build(s) that never reported ready`);

  const counts = await deps.pool.counts(now).catch(() => null);
  if (!counts) return { started: 0, scrapped };

  const want = buildsToStart({ counts, target: deps.target });
  if (want === 0) return { started: 0, scrapped };

  let started = 0;
  for (let i = 0; i < want; i += 1) {
    const name = poolSpriteName(deps.randomId);
    const secret = deps.randomId();

    const made = await deps.provisioner.createNamed(name).catch(() => null);
    if (!made || !made.ok) {
      // A quota refusal is the provider saying "no more", and trying the rest
      // of this sweep would just collect more of the same answer.
      log(`[pool] create failed (${made ? made.kind : "unavailable"}); stopping this sweep`);
      break;
    }

    // The row BEFORE the build command: if the process dies between them, a
    // recorded machine that never started building is scrapped by `failStale`
    // an hour later. The other order leaves a real sprite with no row at all,
    // which nothing ever cleans up.
    const recorded = await deps.pool.add(made.externalId, secret).catch(() => false);
    if (!recorded) {
      log(`[pool] could not record ${made.externalId}; destroying it rather than orphaning it`);
      await deps.provisioner.destroy(made.externalId).catch(() => false);
      continue;
    }

    const kicked = await deps.startBuild(made.externalId, secret).catch(() => false);
    if (!kicked) {
      // The row stays. The machine exists and is paid for either way, and a
      // later sweep's `failStale` is a better place to decide it is hopeless
      // than a `catch` that has no idea whether the command half-ran.
      log(`[pool] ${made.externalId} created but the build command did not go out`);
    }
    started += 1;
  }

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
