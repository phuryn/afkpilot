/**
 * Keeping a cloud machine awake while it is actually working.
 *
 * ## The problem, measured rather than assumed (2026-08-27)
 *
 * A Sprite suspends about a minute after the last EXTERNAL interaction, and
 * suspended means frozen, not merely idle. A service writing a timestamp every
 * five seconds produced samples for 55 seconds and then stopped dead the moment
 * the machine went `warm` — its own output bought it nothing:
 *
 *     samples: 12   first 23:04:18Z   last 23:05:13Z   then silence
 *
 * So a long agent turn does not survive the phone being put down. That is the
 * exact promise this product exists to keep, which makes it the one thing that
 * had to be solved rather than documented.
 *
 * ## What does work
 *
 * Not a poke. Firing an instantaneous command every 30 seconds held the machine
 * at `warm` — awake enough to answer, still frozen between calls. What holds it
 * in `running` is a **session that stays open**:
 *
 *     wss://…/exec?cmd=sh&cmd=-c&cmd=while true; do echo .; sleep 2; done
 *     t+0m cold → t+1m running (socket open)
 *
 * So the relay holds one of those open for as long as the machine is working,
 * and closes it when the work stops. Billing follows the same line: a machine is
 * kept running exactly while it is earning its keep, and is allowed to fall
 * asleep — and stop costing anything — the moment it is not.
 *
 * ## What counts as "working"
 *
 * Traffic on the uplink, and nothing more. The relay does not read frames to
 * decide this: it counts arrivals. An idle host sends nothing at all (verified
 * in a real environment's log — a quiet machine emits no frames between
 * `relay clients: N` lines), so "a frame arrived recently" is a sufficient and
 * payload-blind signal. That keeps this consistent with the relay being
 * policy-free: it can tell that work is happening without knowing what the work
 * is.
 */

/** How long after the last frame a machine is still considered working. */
export const KEEPALIVE_IDLE_MS = 90_000;

/** How often to look for holds that have gone quiet. */
export const KEEPALIVE_SWEEP_MS = 15_000;

export interface KeepAliveHandle {
  release(): void;
}

export interface KeepAliveDeps {
  /** Open a session that holds the machine running until released. */
  hold(externalId: string): KeepAliveHandle;
  now: () => number;
  idleMs?: number;
  log?: (line: string) => void;
}

interface Held {
  externalId: string;
  handle: KeepAliveHandle;
  lastActivityAt: number;
}

/**
 * One hold per machine, released when it goes quiet.
 *
 * Deliberately a small state machine rather than a promise chain: a hold is a
 * resource that costs money for as long as it exists, so "who holds what, and
 * since when" has to be inspectable at any moment.
 */
export class KeepAliveCoordinator {
  private held = new Map<string, Held>();

  constructor(private readonly deps: KeepAliveDeps) {}

  /**
   * A frame arrived from this machine.
   *
   * Cheap on purpose — this runs on every frame. The common case is a `Map`
   * lookup and a number assignment.
   */
  noteActivity(deviceId: string, externalId: string): void {
    const now = this.deps.now();
    const existing = this.held.get(deviceId);
    if (existing) {
      existing.lastActivityAt = now;
      return;
    }
    const handle = this.deps.hold(externalId);
    this.held.set(deviceId, { externalId, handle, lastActivityAt: now });
    this.deps.log?.(`[keepalive] holding ${externalId} awake`);
  }

  /**
   * Release anything that has gone quiet.
   *
   * Returns what it released, so a caller can log or test it without reaching
   * into the map.
   */
  sweep(): string[] {
    const now = this.deps.now();
    const idleMs = this.deps.idleMs ?? KEEPALIVE_IDLE_MS;
    const released: string[] = [];
    for (const [deviceId, entry] of [...this.held]) {
      if (now - entry.lastActivityAt < idleMs) continue;
      this.held.delete(deviceId);
      try {
        entry.handle.release();
      } catch {
        /* the socket is going either way */
      }
      released.push(entry.externalId);
      this.deps.log?.(`[keepalive] released ${entry.externalId} after ${idleMs}ms quiet`);
    }
    return released;
  }

  /**
   * Release one immediately — the uplink has gone.
   *
   * A machine whose host disconnected is not working, whatever the clock says,
   * and paying to hold a socket open against it earns nothing.
   */
  releaseFor(deviceId: string): void {
    const entry = this.held.get(deviceId);
    if (!entry) return;
    this.held.delete(deviceId);
    try {
      entry.handle.release();
    } catch {
      /* already gone */
    }
    this.deps.log?.(`[keepalive] released ${entry.externalId} (uplink gone)`);
  }

  /** Is this machine currently being held awake? */
  holding(deviceId: string): boolean {
    return this.held.has(deviceId);
  }

  /** How many machines are being paid for right now. */
  size(): number {
    return this.held.size;
  }

  /** Release everything — shutdown. */
  releaseAll(): void {
    for (const deviceId of [...this.held.keys()]) this.releaseFor(deviceId);
  }
}

/** Run {@link KeepAliveCoordinator.sweep} on a timer. Returns its stopper. */
export function startKeepAliveSweeper(
  coordinator: KeepAliveCoordinator,
  everyMs = KEEPALIVE_SWEEP_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      coordinator.sweep();
    } catch {
      /* a failed sweep must not take the relay down */
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
