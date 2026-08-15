// MinuteRateLimiter — pure unit tests, injected time. (The weekly quota moved
// to the UsageStore seam — see usage.test.ts for the window + store tests.)
import { describe, it, expect } from "vitest";
import { countMachines, MinuteRateLimiter } from "../src/limits.js";

describe("countMachines", () => {
  it("keeps today's row count until a discriminated id is present", () => {
    expect(countMachines([{ installId: "machine-a" }, { installId: "machine-a" }, {}])).toBe(3);
  });

  it("shares a slot across clients with the same machine prefix", () => {
    expect(
      countMachines([
        { installId: "machine-a" },
        { installId: "machine-a:desktop" },
        { installId: "machine-b:desktop" },
        {},
      ]),
    ).toBe(3);
  });

  it("does not let an unknown suffix share the machine slot", () => {
    expect(
      countMachines([
        { installId: "machine-a" },
        { installId: "machine-a:desktop" },
        { installId: "machine-a:x" },
        { installId: "machine-a:y" },
      ]),
    ).toBe(3);
  });
});

describe("MinuteRateLimiter", () => {
  it("caps within a calendar minute and resets on the next", () => {
    let now = Date.UTC(2026, 6, 15, 10, 0, 30);
    const r = new MinuteRateLimiter(() => now);
    expect(r.take("u1", 2)).toBe(true);
    expect(r.take("u1", 2)).toBe(true);
    expect(r.take("u1", 2)).toBe(false);
    now = Date.UTC(2026, 6, 15, 10, 1, 0); // next minute bucket
    expect(r.take("u1", 2)).toBe(true);
  });

  it("is keyed per user and never over-counts on refusals", () => {
    const now = Date.UTC(2026, 6, 15, 10, 0, 30);
    const r = new MinuteRateLimiter(() => now);
    expect(r.take("u1", 1)).toBe(true);
    expect(r.take("u1", 1)).toBe(false);
    expect(r.used("u1")).toBe(1);
    expect(r.take("u2", 1)).toBe(true);
  });

  it("lazily evicts every stale identity when the minute changes", () => {
    let now = Date.UTC(2026, 6, 15, 10, 0, 30);
    const r = new MinuteRateLimiter(() => now);
    for (let i = 0; i < 100; i++) expect(r.take(`departed-${i}`, 1)).toBe(true);
    expect(r.trackedIds()).toBe(100);

    now = Date.UTC(2026, 6, 15, 10, 1, 0);
    expect(r.take("current", 1)).toBe(true);
    expect(r.trackedIds()).toBe(1);
    expect(r.used("departed-0")).toBe(0);
  });
});
