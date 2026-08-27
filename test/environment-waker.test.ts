/**
 * Waking, de-duplicated and bounded.
 *
 * The two behaviours worth pinning are both about failure modes that cost money
 * or patience rather than correctness: N tabs attaching must be ONE provider
 * call, and a wake that hangs must resolve as a failure rather than spin the
 * picker for ever.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WakeCoordinator, spriteWaker, type WakeOutcome } from "../src/environment-waker";
import { WAKE_TIMEOUT_MS, type EnvironmentRecord } from "../src/environments";

const env = (over: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  deviceId: "d1",
  userId: "u1",
  provider: "sprite",
  externalId: "afkpilot-abc",
  wakeAt: null,
  createdAt: 0,
  ...over,
});

describe("de-duplicating wakes", () => {
  it("makes one provider call for many simultaneous attaches", async () => {
    let calls = 0;
    let release!: (v: WakeOutcome) => void;
    const gate = new Promise<WakeOutcome>((r) => { release = r; });
    const c = new WakeCoordinator({ wake: () => { calls += 1; return gate; } });

    const all = Promise.all([c.wake(env()), c.wake(env()), c.wake(env())]);
    expect(calls).toBe(1);
    expect(c.waking("d1")).toBe(true);
    release({ ok: true });
    expect(await all).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(c.waking("d1")).toBe(false);
  });

  it("still wakes different devices independently", async () => {
    const seen: string[] = [];
    const c = new WakeCoordinator({
      wake: async (e) => { seen.push(e.deviceId); return { ok: true }; },
    });
    await Promise.all([c.wake(env({ deviceId: "a" })), c.wake(env({ deviceId: "b" }))]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("allows a fresh attempt once the first has settled", async () => {
    let calls = 0;
    const c = new WakeCoordinator({ wake: async () => { calls += 1; return { ok: true }; } });
    await c.wake(env());
    await c.wake(env());
    expect(calls).toBe(2);
  });
});

describe("remembering failure", () => {
  it("records why, so the picker can say offline instead of ready", async () => {
    const c = new WakeCoordinator({ wake: async () => ({ ok: false, kind: "quota" }) });
    await c.wake(env());
    expect(c.failure("d1")).toBe("quota");
  });

  it("clears it on a later success", async () => {
    let ok = false;
    const c = new WakeCoordinator({ wake: async () => (ok ? { ok: true } : { ok: false, kind: "unavailable" }) });
    await c.wake(env());
    expect(c.failure("d1")).toBe("unavailable");
    ok = true;
    await c.wake(env());
    expect(c.failure("d1")).toBeUndefined();
  });

  it("treats a thrown provider call as a failure, not a crash", async () => {
    const c = new WakeCoordinator({ wake: async () => { throw new Error("boom"); } });
    expect(await c.wake(env())).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("bounding a wake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails a hanging wake rather than spinning for ever", async () => {
    // A wake that never resolves shows `waking` indefinitely, and the reader has
    // nothing to do about it. That is worse than a failure.
    const c = new WakeCoordinator({ wake: () => new Promise<WakeOutcome>(() => {}) });
    const p = c.wake(env());
    await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS + 1);
    expect(await p).toEqual({ ok: false, kind: "unavailable" });
    expect(c.waking("d1")).toBe(false);
  });
});

describe("the sprite waker", () => {
  const call = async (status: number) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const wake = spriteWaker({
      token: "t",
      apiBase: "https://api.example",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), init });
        return { status } as Response;
      }) as unknown as typeof fetch,
    });
    return { outcome: await wake(env()), seen };
  };

  it("treats ONLY a 2xx as a wake", async () => {
    // The bug this replaced: a plain GET to a sprite URL returns 302 from Fly's
    // auth edge in ~577ms WITHOUT waking anything. Accepting "any response that
    // arrived" reported every sleeping environment as awake and started none.
    expect((await call(200)).outcome).toEqual({ ok: true });
    expect((await call(204)).outcome).toEqual({ ok: true });
    for (const status of [302, 401, 403, 500, 502]) {
      expect((await call(status)).outcome).toEqual({ ok: false, kind: "unavailable" });
    }
  });

  it("maps only the statuses that change what a person can do", async () => {
    expect((await call(404)).outcome).toEqual({ ok: false, kind: "gone" });
    expect((await call(410)).outcome).toEqual({ ok: false, kind: "gone" });
    expect((await call(402)).outcome).toEqual({ ok: false, kind: "quota" });
    expect((await call(429)).outcome).toEqual({ ok: false, kind: "quota" });
  });

  it("reports a network failure as try-again", async () => {
    const wake = spriteWaker({
      token: "t",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(await wake(env())).toEqual({ ok: false, kind: "unavailable" });
  });

  it("posts the cheapest possible command to the authenticated exec endpoint", async () => {
    const { seen } = await call(200);
    expect(seen[0].url).toBe("https://api.example/v1/sprites/afkpilot-abc/exec");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers).toMatchObject({ authorization: "Bearer t" });
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ cmd: "true" });
  });

  it("escapes a sprite name into the path", async () => {
    const seen: string[] = [];
    const wake = spriteWaker({
      token: "t",
      apiBase: "https://api.example/",
      fetchImpl: (async (url: string) => { seen.push(String(url)); return { status: 200 } as Response; }) as unknown as typeof fetch,
    });
    await wake({ ...env(), externalId: "a b/c" });
    expect(seen[0]).toBe("https://api.example/v1/sprites/a%20b%2Fc/exec");
  });
});
