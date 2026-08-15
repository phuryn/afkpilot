// Usage counter store — one aggregate count per user + Warsaw usage window.
// Message content and per-message rows never cross this seam.

/** The free-tier usage window: anchored to TUESDAY 17:00 Europe/Warsaw
 *  (owner's call, 2026-07-24 — "5 PM CET" as the Warsaw wall clock, so the
 *  reset stays 17:00 local through DST in both directions). There is no cron:
 *  the window START is the counter's storage key, and the increment RPC drops
 *  a user's older windows lazily. */
export function usageWindow(nowMs: number): { start: number; resetsAt: number } {
  const now = warsawParts(nowMs);
  // Days back to Tuesday (JS weekday: Sun=0..Sat=6; Tuesday=2). A Tuesday
  // before 17:00 wall time still belongs to LAST week's window.
  let daysBack = (now.weekday - 2 + 7) % 7;
  if (daysBack === 0 && now.hour < 17) daysBack = 7;
  const start = warsawWallToUtc(now.year, now.month, now.day - daysBack, 17);
  const resetsAt = warsawWallToUtc(now.year, now.month, now.day - daysBack + 7, 17);
  return { start, resetsAt };
}

/** Coarse single-unit countdown for the meter/wall: "4d", "5h", "15m". */
export function resetsInText(msRemaining: number): string {
  if (msRemaining >= 48 * 3600_000) return `${Math.round(msRemaining / 86400_000)}d`;
  if (msRemaining >= 3600_000) return `${Math.round(msRemaining / 3600_000)}h`;
  return `${Math.max(1, Math.round(msRemaining / 60_000))}m`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const warsawFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

function warsawParts(ms: number): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const p: Record<string, string> = {};
  for (const part of warsawFmt.formatToParts(ms)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month) - 1, // Date.UTC-style 0-based
    day: Number(p.day),
    hour: Number(p.hour) % 24, // h23 still yields "24" at midnight in some ICUs
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday ?? ""),
  };
}

/** The UTC instant at which Warsaw's wall clock shows y-m-d h:00. Two guess
 *  passes converge across DST edges (the first lands within an hour, the
 *  second corrects for the offset AT that corrected instant). Out-of-range
 *  day values normalize like Date.UTC (day 0 = last of previous month). */
function warsawWallToUtc(year: number, month: number, day: number, hour: number): number {
  const want = Date.UTC(year, month, day, hour);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const shown = warsawParts(ts);
    ts += want - Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute);
  }
  return ts;
}

export interface UsageStore {
  /** Increment and return the new count for this user + window. */
  increment(userId: string, windowStartMs: number): Promise<number>;
  /** Return the current count, or zero when this window has no row. */
  peek(userId: string, windowStartMs: number): Promise<number>;
}

/** Dev/mock implementation. Old windows are discarded when a user is touched. */
export class InMemoryUsageStore implements UsageStore {
  private counts = new Map<string, { windowStartMs: number; count: number }>();

  async increment(userId: string, windowStartMs: number): Promise<number> {
    const current = this.counts.get(userId);
    const count = current?.windowStartMs === windowStartMs ? current.count + 1 : 1;
    this.counts.set(userId, { windowStartMs, count });
    return count;
  }

  async peek(userId: string, windowStartMs: number): Promise<number> {
    const current = this.counts.get(userId);
    if (!current || current.windowStartMs === windowStartMs) return current?.count ?? 0;
    this.counts.delete(userId);
    return 0;
  }
}
