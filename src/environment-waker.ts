/**
 * Waking an environment — the impure edge, behind an injectable seam.
 *
 * Separate from `environments.ts` for the reason every other impure module here
 * is separate: the decisions are worth unit-testing and a real provider call is
 * not. `server.ts` holds a `WakeCoordinator`; what actually pokes Fly lives at
 * the bottom of this file and is one function.
 *
 * ## The wake is an inbound HTTP request
 *
 * Not an API call to a control plane, and not anything over the uplink — the
 * uplink is the thing that died. A sprite has its own authenticated URL, and a
 * request to it wakes the machine. That is the entire mechanism: the response
 * does not matter, the arrival does.
 *
 * ## De-duplication is the point of this class
 *
 * Three browser tabs attaching at once must produce ONE wake. Without that,
 * every reconnect storm becomes N provider calls for a machine that was already
 * coming up, and the failure mode is a bill rather than an error.
 */
import {
  WAKE_TIMEOUT_MS,
  type EnvironmentRecord,
  type WakeFailure,
} from "./environments.js";

export type WakeOutcome = { ok: true } | { ok: false; kind: WakeFailure };

/** The provider call. Injected so tests never touch the network. */
export type WakeFn = (environment: EnvironmentRecord) => Promise<WakeOutcome>;

export interface WakeCoordinatorDeps {
  wake: WakeFn;
  now?: () => number;
  log?: (line: string) => void;
}

export class WakeCoordinator {
  /** deviceId -> the wake currently in flight for it. */
  private inFlight = new Map<string, Promise<WakeOutcome>>();
  /** deviceId -> why the last wake failed, so the picker can say `offline`. */
  private failures = new Map<string, WakeFailure>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WakeCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Is a wake in flight for this device right now? */
  waking(deviceId: string): boolean {
    return this.inFlight.has(deviceId);
  }

  /** Why the last wake failed, if it did. Cleared by a later success. */
  failure(deviceId: string): WakeFailure | undefined {
    return this.failures.get(deviceId);
  }

  /**
   * Wake it, or join the wake already running.
   *
   * Callers get the same promise, so N attaching tabs cost one provider call.
   */
  async wake(environment: EnvironmentRecord): Promise<WakeOutcome> {
    const existing = this.inFlight.get(environment.deviceId);
    if (existing) return existing;

    const started = this.now();
    const attempt = this.run(environment)
      .then((outcome) => {
        if (outcome.ok) this.failures.delete(environment.deviceId);
        else this.failures.set(environment.deviceId, outcome.kind);
        this.log(
          `[env] wake ${environment.externalId}: ${outcome.ok ? "ok" : outcome.kind} `
          + `(${this.now() - started}ms)`,
        );
        return outcome;
      })
      .finally(() => {
        this.inFlight.delete(environment.deviceId);
      });

    this.inFlight.set(environment.deviceId, attempt);
    return attempt;
  }

  /**
   * A wake that hangs is worse than one that fails: the picker shows `waking`
   * for ever and the reader has nothing to do. Bound it here rather than
   * trusting whatever fetch the provider function chose.
   */
  private async run(environment: EnvironmentRecord): Promise<WakeOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<WakeOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, kind: "unavailable" }), WAKE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.deps.wake(environment).catch((): WakeOutcome => ({ ok: false, kind: "unavailable" })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * The real thing: an authenticated request to the sprite's own URL.
 *
 * Status codes are mapped, not forwarded. A person is never shown a provider
 * error (see `wakeFailureText`), so the only distinctions worth preserving are
 * the ones that change what they can do: gone, over a limit, or try again.
 */
export function spriteWaker(opts: {
  token: string;
  urlFor?: (externalId: string) => string;
  fetchImpl?: typeof fetch;
}): WakeFn {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Sprite URLs carry a per-sprite suffix, so the caller supplies the mapping
  // rather than this guessing a hostname from a name.
  const urlFor = opts.urlFor ?? ((id: string) => `https://${id}.sprites.app/`);
  return async (environment) => {
    const res = await fetchImpl(urlFor(environment.externalId), {
      method: "GET",
      headers: { authorization: `Bearer ${opts.token}` },
      redirect: "manual",
    }).catch(() => null);
    if (!res) return { ok: false, kind: "unavailable" };
    if (res.status === 404 || res.status === 410) return { ok: false, kind: "gone" };
    if (res.status === 402 || res.status === 429) return { ok: false, kind: "quota" };
    // Anything else that ARRIVED woke it. A 401 or a 500 from the sprite's own
    // app still means the machine is up, which is all a wake is for — and
    // treating those as failure would show `offline` for a running box.
    return { ok: true };
  };
}
