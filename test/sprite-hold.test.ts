/**
 * The hold, and the ways it can quietly stop holding.
 *
 * A hold that fails loudly is fine — the machine sleeps, somebody notices. The
 * dangerous failure is a hold that reports success and does nothing: the
 * coordinator believes the machine is protected, every heartbeat refreshes a
 * socket that was never there, and the machine suspends mid-turn with nothing
 * anywhere saying so.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spriteHold, HOLD_HANDSHAKE_MS } from "../src/sprite-exec";

/** Just enough of a `ws` socket to drive the paths that matter. */
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0; // CONNECTING
  closed = false;
  constructor(readonly url: string, readonly headers: Record<string, string>, readonly handshakeTimeout?: number) {
    super();
  }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.closed = true; this.readyState = 3; this.emit("close"); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const hold = spriteHold({
    token: "t",
    apiBase: "https://api.example",
    connect: (url, headers, handshakeTimeout) => {
      const s = new FakeSocket(url, headers, handshakeTimeout);
      sockets.push(s);
      return s as unknown as never;
    },
  });
  return { hold, sockets };
}

describe("opening a hold", () => {
  it("asks for a heartbeat command on the named machine", () => {
    const { hold, sockets } = harness();
    hold("sprite-1");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain("/v1/sprites/sprite-1/exec?");
    expect(sockets[0].url).toContain("cmd=sh");
    expect(sockets[0].headers.authorization).toBe("Bearer t");
  });

  it("bounds the upgrade", () => {
    // Without this the socket can sit mid-handshake for ever.
    const { hold, sockets } = harness();
    hold("sprite-1");
    expect(sockets[0].handshakeTimeout).toBe(HOLD_HANDSHAKE_MS);
  });
});

describe("a hold that never connects", () => {
  it("is abandoned and retried rather than believed", () => {
    // THE failure with no symptom. Retries hang off `close`, so a socket that
    // stalls mid-upgrade and emits neither `open` nor `close` would never be
    // retried — while the coordinator, which records the handle synchronously,
    // goes on reporting the machine as held.
    vi.useFakeTimers();
    try {
      const { hold, sockets } = harness();
      hold("sprite-1");
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(HOLD_HANDSHAKE_MS + 5_000 + 1);
      expect(sockets[0].closed).toBe(true);
      vi.advanceTimersByTime(2_500);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a connected hold alone", () => {
    // The watchdog must not close a socket that did its job.
    vi.useFakeTimers();
    try {
      const { hold, sockets } = harness();
      hold("sprite-1");
      sockets[0].open();
      vi.advanceTimersByTime(HOLD_HANDSHAKE_MS + 60_000);
      expect(sockets[0].closed).toBe(false);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a hold that drops", () => {
  it("reconnects, because the turn it protects is still running", () => {
    vi.useFakeTimers();
    try {
      const { hold, sockets } = harness();
      hold("sprite-1");
      sockets[0].open();
      sockets[0].close();
      vi.advanceTimersByTime(2_500);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("releasing", () => {
  it("closes the socket and stops reconnecting", () => {
    vi.useFakeTimers();
    try {
      const { hold, sockets } = harness();
      const h = hold("sprite-1");
      sockets[0].open();
      h.release();
      expect(sockets[0].closed).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a hold that was still mid-handshake", () => {
    // Otherwise the watchdog fires after release and starts reconnecting a hold
    // nobody asked for any more — a machine billed by a coordinator that has
    // forgotten it.
    vi.useFakeTimers();
    try {
      const { hold, sockets } = harness();
      const h = hold("sprite-1");
      h.release();
      vi.advanceTimersByTime(HOLD_HANDSHAKE_MS + 60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
