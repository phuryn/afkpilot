// Reconnect delay schedule — pure, injected clock + rng.
//
// Floor ~1s, doubles each failure, caps ~30s, equal jitter in [half, full].
// Reset only after a connection has stayed open for the floor — never on the
// OPEN event itself. A host (or tab) that opens and dies in milliseconds
// would otherwise retry every second forever.
//
// Visibility / "reconnect now" is the caller's job. This module only answers
// "how long to wait" and "has this attempt lasted long enough to count as
// stable". Floor, cap, jitter: no third tuning knob.

export const RECONNECT_FLOOR_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

export interface ReconnectBackoffDeps {
  now: () => number;
  /** In [0, 1). Injected so jitter bounds are deterministic in tests. */
  random: () => number;
  floorMs?: number;
  capMs?: number;
}

export class ReconnectBackoff {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly floorMs: number;
  private readonly capMs: number;
  private delayMs: number;
  private openedAt: number | null = null;

  constructor(deps: ReconnectBackoffDeps) {
    this.now = deps.now;
    this.random = deps.random;
    this.floorMs = deps.floorMs ?? RECONNECT_FLOOR_MS;
    this.capMs = deps.capMs ?? RECONNECT_CAP_MS;
    this.delayMs = this.floorMs;
  }

  /** Jittered delay for the next retry, then grow the base toward the cap. */
  nextDelayMs(): number {
    const base = this.delayMs;
    this.delayMs = Math.min(this.capMs, this.delayMs * 2);
    return jitter(base, this.random());
  }

  /** Socket opened. Does NOT reset — a flap that reaches OPEN is still a flap. */
  noteOpen(): void {
    this.openedAt = this.now();
  }

  /**
   * Socket closed. Reset to the floor only if it stayed up for at least the
   * floor duration (the same constant, not a third parameter).
   */
  noteClosed(): void {
    if (this.openedAt !== null && this.now() - this.openedAt >= this.floorMs) {
      this.reset();
      return;
    }
    this.openedAt = null;
  }

  /** Immediate retry at the floor — becoming visible, focus, or a user action. */
  reset(): void {
    this.delayMs = this.floorMs;
    this.openedAt = null;
  }
}

/** Equal jitter: [0.5 * delay, delay]. `random` in [0, 1]. */
export function jitter(delayMs: number, random: number): number {
  return delayMs * (0.5 + 0.5 * random);
}
