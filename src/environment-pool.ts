/**
 * How many cloud environments to keep on the shelf, and when to build more.
 *
 * Pure, like `environments.ts` — the decisions live here so they can be tested
 * without a provider, and the calls that cost money live in
 * `environment-provisioner.ts`.
 *
 * Nothing here watches a build. A machine reports its own readiness, because an
 * install takes ~25 minutes and holding a connection open for that is a bet
 * against the network rather than a design.
 *
 * ## Why a pool at all
 *
 * Creating a sprite takes a second. Making one USEFUL took 25 minutes when
 * measured end to end on 2026-08-27 — apt 58s, clone 77s, `npm ci` 20 minutes
 * (I/O-bound on the VM's writable overlay, which is pathological for
 * `node_modules`), compile 4.6 minutes. That is not a wait anyone will sit
 * through after clicking a button.
 *
 * Building ahead of demand does not make the install cheaper. It makes it
 * invisible: the machines are built while nobody is waiting, and the first open
 * takes one off the shelf. Somebody waits the full build only when the shelf is
 * empty — the one case where there was nothing to hand them anyway.
 *
 * A parked sprite is close to free. Fly's pricing example bills 10 GB of cold
 * storage for four hours at $0.00, and a sprite nobody has woken is cold
 * storage and nothing else.
 */

/** Default shelf depth. Overridden by CLOUD_POOL_SIZE. */
export const DEFAULT_POOL_SIZE = 20;

/**
 * How many builds to start in one sweep.
 *
 * A cold start with an empty table wants twenty machines at once, which is
 * twenty simultaneous `POST /v1/sprites` calls followed by twenty simultaneous
 * `npm ci` runs against the same registry. Spreading them over sweeps costs
 * nothing — the pool is being filled ahead of demand, so it has time — and
 * keeps a burst of failures small enough to notice before it is twenty.
 */
export const MAX_BUILDS_PER_SWEEP = 3;

/**
 * When a build is presumed dead.
 *
 * Nobody is holding the machine's hand through a 25-minute install, so a build
 * that never reports is indistinguishable from one still going. 25 minutes was
 * the measured happy path; 60 gives it well over double before we stop counting
 * it toward the target. Counting a dead build forever is how a pool quietly
 * empties: every sweep sees "20 building", starts nothing, and hands out
 * nothing.
 */
export const BUILD_TIMEOUT_MS = 60 * 60_000;

/** How often the filler looks at the shelf. */
export const FILL_INTERVAL_MS = 60_000;

export interface PoolCounts {
  ready: number;
  building: number;
}

export interface TopUpInput {
  counts: PoolCounts;
  target: number;
  maxPerSweep?: number;
}

/**
 * How many builds to start right now.
 *
 * Counts `building` toward the target so a sweep every minute does not start a
 * second wave on top of a first that has not finished — twenty minutes of
 * builds would otherwise become sixty machines.
 */
export function buildsToStart(input: TopUpInput): number {
  const target = Math.max(0, Math.floor(input.target));
  if (target === 0) return 0;
  const have = Math.max(0, input.counts.ready) + Math.max(0, input.counts.building);
  const short = target - have;
  if (short <= 0) return 0;
  return Math.min(short, input.maxPerSweep ?? MAX_BUILDS_PER_SWEEP);
}

export interface StaleInput {
  startedAt: number;
  now: number;
  timeoutMs?: number;
}

/**
 * Whether a build has been going long enough to stop believing in it.
 *
 * Deliberately generous. Marking a live build failed strands a machine that was
 * about to be useful, and the cost of waiting longer is one slot on a shelf.
 */
export function buildIsStale(input: StaleInput): boolean {
  return input.now - input.startedAt >= (input.timeoutMs ?? BUILD_TIMEOUT_MS);
}

/**
 * Parse CLOUD_POOL_SIZE.
 *
 * Unset means ZERO, not the default depth: turning a pool on provisions real
 * machines that cost real money, and that should happen because somebody set a
 * number, never because a deploy inherited one. `DEFAULT_POOL_SIZE` is the
 * documented value to set, not a value that appears on its own.
 */
export function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * The name of a pooled sprite.
 *
 * Random rather than derived, because there is no user to derive it from — a
 * pool sprite belongs to nobody until it is claimed. The prefix is what tells
 * an operator, looking at a list of sprites, which ones are on the shelf and
 * which ones somebody is using.
 */
export function poolSpriteName(random: () => string): string {
  return `afkpilot-pool-${random().replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase()}`;
}

/** Is this a pooled machine, by name alone? */
export function isPoolSpriteName(name: string): boolean {
  return /^afkpilot-pool-[0-9a-f]{1,12}$/.test(name);
}

export type ClaimOutcome =
  | { ok: true; externalId: string; fromPool: true }
  | { ok: false; reason: "empty" };

/**
 * What an open should do, given what the shelf offered.
 *
 * Separated from the endpoint so the fallback is a decision with a name rather
 * than an `if` buried in a request handler: an empty pool is NOT a failure, it
 * is the on-demand path, which is the same path a first user took before any
 * pool existed and is therefore the one that is actually tested.
 */
export function claimOutcome(claimed: { externalId: string } | null): ClaimOutcome {
  if (!claimed) return { ok: false, reason: "empty" };
  return { ok: true, externalId: claimed.externalId, fromPool: true };
}
