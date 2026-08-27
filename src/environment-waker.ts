/**
 * Waking an environment — the impure edge, behind an injectable seam.
 *
 * Separate from `environments.ts` for the reason every other impure module here
 * is separate: the decisions are worth unit-testing and a real provider call is
 * not. `server.ts` holds a `WakeCoordinator`; what actually pokes Fly lives at
 * the bottom of this file and is one function.
 *
 * ## The wake is an authenticated API call
 *
 * Not anything over the uplink — the uplink is the thing that died. And NOT a
 * plain request to the sprite public URL either, which was the first design and
 * was wrong: that returns 302 from an auth edge without reaching the machine.
 * See {@link spriteWaker} for what was measured.
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
 * The real thing: an authenticated call to the provider's API.
 *
 * MEASURED, and the obvious approach was wrong. A plain GET to a sprite's public
 * URL returns **302 in ~577 ms and does not wake it** — that redirect comes from
 * Fly's auth edge, which answers without the request ever reaching the machine.
 * An earlier version of this function treated "any response that arrived" as a
 * wake and would have reported every sleeping environment as awake while never
 * starting one.
 *
 * `POST /v1/sprites/{name}/exec` is authenticated, reaches the machine, and is
 * what the CLI itself uses — timing a `sprite exec` against a COLD sprite gave
 * 1775 ms versus a 1120 ms warm baseline, so the wake is real and costs about
 * 650 ms. `/wake`, `/start` and `/resume` do not exist (404, all three).
 *
 * Running a command to wake something reads as odd, and `true` is the cheapest
 * possible one. The alternative — an authenticated request to the sprite's own
 * URL — may also work, but its auth story is not established and this one is.
 *
 * Status codes are mapped, not forwarded. A person is never shown a provider
 * error (see `wakeFailureText`), so the only distinctions preserved are the ones
 * that change what they can do: gone, over a limit, or try again.
 */
export function spriteWaker(opts: {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): WakeFn {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.sprites.dev").replace(/\/+$/, "");
  return async (environment) => {
    const res = await fetchImpl(
      `${base}/v1/sprites/${encodeURIComponent(environment.externalId)}/exec`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/json",
        },
        // The cheapest command that exists. We want the machine up, not output.
        body: JSON.stringify({ cmd: "true" }),
      },
    ).catch(() => null);
    if (!res) return { ok: false, kind: "unavailable" };
    if (res.status === 404 || res.status === 410) return { ok: false, kind: "gone" };
    if (res.status === 402 || res.status === 429) return { ok: false, kind: "quota" };
    // Only a 2xx means the command ran, which is the only proof the machine is
    // up. A 3xx here would be an edge answering on the sprite's behalf — the
    // exact failure this function was rewritten to stop treating as success.
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, kind: "unavailable" };
  };
}
