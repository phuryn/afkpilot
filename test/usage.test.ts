// usageWindow (Tuesday 17:00 Europe/Warsaw, DST-aware) + resetsInText +
// InMemoryUsageStore — pure unit tests.
import { describe, it, expect } from "vitest";
import { usageWindow, resetsInText, InMemoryUsageStore } from "../src/usage.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("usageWindow", () => {
  it("anchors to the most recent Tuesday 17:00 Warsaw (summer: 15:00Z)", () => {
    // Wed 2026-07-15 12:00Z — CEST (UTC+2): Tue 17:00 local = 15:00Z.
    const w = usageWindow(Date.UTC(2026, 6, 15, 12));
    expect(iso(w.start)).toBe("2026-07-14T15:00:00.000Z");
    expect(iso(w.resetsAt)).toBe("2026-07-21T15:00:00.000Z");
  });

  it("a Tuesday before 17:00 local still belongs to LAST week's window", () => {
    // Tue 2026-07-14 08:00Z = 10:00 CEST.
    const w = usageWindow(Date.UTC(2026, 6, 14, 8));
    expect(iso(w.start)).toBe("2026-07-07T15:00:00.000Z");
    expect(iso(w.resetsAt)).toBe("2026-07-14T15:00:00.000Z");
  });

  it("exactly 17:00 Warsaw opens the NEW window", () => {
    const boundary = Date.UTC(2026, 6, 14, 15); // Tue 17:00 CEST
    const w = usageWindow(boundary);
    expect(w.start).toBe(boundary);
    const before = usageWindow(boundary - 1);
    expect(iso(before.start)).toBe("2026-07-07T15:00:00.000Z");
  });

  it("spring DST week: start 17:00 CET (16:00Z), reset 17:00 CEST (15:00Z)", () => {
    // Clocks jump forward Sun 2026-03-29. Sat 2026-03-28 12:00Z is inside the
    // window that STARTED Tue 03-24 (winter) and RESETS Tue 03-31 (summer):
    // both are 17:00 on the Warsaw wall clock.
    for (const now of [Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 30, 12)]) {
      const w = usageWindow(now);
      expect(iso(w.start)).toBe("2026-03-24T16:00:00.000Z");
      expect(iso(w.resetsAt)).toBe("2026-03-31T15:00:00.000Z");
    }
  });

  it("autumn DST week: start 17:00 CEST (15:00Z), reset 17:00 CET (16:00Z)", () => {
    // Clocks fall back Sun 2026-10-25; Mon 10-26 is after the switch but the
    // window still runs Tue 10-20 (summer) -> Tue 10-27 (winter), 17:00 local.
    const w = usageWindow(Date.UTC(2026, 9, 26, 12));
    expect(iso(w.start)).toBe("2026-10-20T15:00:00.000Z");
    expect(iso(w.resetsAt)).toBe("2026-10-27T16:00:00.000Z");
  });
});

describe("resetsInText", () => {
  it("uses the largest single unit that fits", () => {
    expect(resetsInText(3 * 86400_000)).toBe("3d");
    expect(resetsInText(49 * 3600_000)).toBe("2d");
    expect(resetsInText(5.4 * 3600_000)).toBe("5h");
    expect(resetsInText(15 * 60_000)).toBe("15m");
    expect(resetsInText(20_000)).toBe("1m"); // never "0m"
  });
});

describe("InMemoryUsageStore", () => {
  it("increments within a window and resets on a new one", async () => {
    const s = new InMemoryUsageStore();
    expect(await s.increment("u1", 1000)).toBe(1);
    expect(await s.increment("u1", 1000)).toBe(2);
    expect(await s.peek("u1", 1000)).toBe(2);
    expect(await s.increment("u1", 2000)).toBe(1); // new window
    expect(await s.peek("u1", 2000)).toBe(1);
  });

  it("is keyed per user and peeks 0 for untouched users/windows", async () => {
    const s = new InMemoryUsageStore();
    await s.increment("u1", 1000);
    expect(await s.peek("u2", 1000)).toBe(0);
    expect(await s.peek("u1", 2000)).toBe(0); // old row dropped
  });
});
