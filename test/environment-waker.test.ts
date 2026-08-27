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
import { spriteExecUrl, type SpriteExecResult } from "../src/sprite-exec";
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
  /**
   * A wake runs `true` on the machine over the exec WEBSOCKET and insists on an
   * exit code. Two earlier versions accepted an answer from something that was
   * not the machine — a 302 from Fly's auth edge, then a 200 from
   * `POST /v1/sprites/{name}/exec`, which returns success having run nothing at
   * all. Both reported every sleeping environment as awake and started none, so
   * "a command ran and reported its status" is the whole point of this suite.
   */
  const wakeWith = (result: Partial<SpriteExecResult>, seen?: { name: string; argv: readonly string[] }[]) =>
    spriteWaker({
      token: "t",
      apiBase: "https://api.example",
      execImpl: async (name, argv) => {
        seen?.push({ name, argv });
        return { ok: false, exitCode: null, output: "", ...result };
      },
    });

  it("counts a command that ran as a wake, whatever it exited with", async () => {
    // A non-zero exit is still proof of life, and life is the only question
    // being asked here.
    expect(await wakeWith({ ok: true, exitCode: 0 })(env())).toEqual({ ok: true });
    expect(await wakeWith({ ok: true, exitCode: 1 })(env())).toEqual({ ok: true });
  });

  it("refuses to call a connection that never produced an exit code a wake", async () => {
    // The exact shape of the bug this replaced: something answered, nothing ran.
    expect(await wakeWith({ ok: false, error: "closed before exit" })(env()))
      .toEqual({ ok: false, kind: "unavailable" });
    expect(await wakeWith({ ok: false, error: "timeout" })(env()))
      .toEqual({ ok: false, kind: "unavailable" });
    expect(await wakeWith({ ok: true, exitCode: null })(env()))
      .toEqual({ ok: false, kind: "unavailable" });
  });

  it("maps only the failures that change what a person can do", async () => {
    // `gone` unlinks a row; `quota` is worth saying out loud. Everything else
    // is try-again, and saying more than that would be inventing detail.
    expect(await wakeWith({ error: "http 404" })(env())).toEqual({ ok: false, kind: "gone" });
    expect(await wakeWith({ error: "http 410" })(env())).toEqual({ ok: false, kind: "gone" });
    expect(await wakeWith({ error: "http 402" })(env())).toEqual({ ok: false, kind: "quota" });
    expect(await wakeWith({ error: "http 429" })(env())).toEqual({ ok: false, kind: "quota" });
    for (const e of ["http 401", "http 500", "http 502", "ECONNREFUSED"]) {
      expect(await wakeWith({ error: e })(env())).toEqual({ ok: false, kind: "unavailable" });
    }
  });

  it("runs the cheapest command there is, on the named machine", async () => {
    const seen: { name: string; argv: readonly string[] }[] = [];
    await wakeWith({ ok: true, exitCode: 0 }, seen)(env());
    expect(seen).toEqual([{ name: "afkpilot-abc", argv: ["true"] }]);
  });

  it("builds an exec URL that escapes the sprite name", async () => {
    // The name reaches the wire through spriteExecUrl; this pins that a wake
    // uses that path rather than pasting a name into a URL itself.
    expect(spriteExecUrl({ apiBase: "https://api.example/", name: "a b/c", argv: ["true"] }))
      .toBe("wss://api.example/v1/sprites/a%20b%2Fc/exec?cmd=true");
  });
});
