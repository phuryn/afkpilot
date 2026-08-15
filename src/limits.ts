// Usage limits — pure module. The relay stays policy-free about WHAT a remote
// may do (that's the extension's remote-policy gate); this is only HOW MUCH:
// the free tier's device cap + weekly prompt quota (upgrade nudge), and a
// per-minute burst cap that applies to EVERYONE (abuse guard, paid included).
//
// The weekly quota counts through a UsageStore (usage.ts) — Supabase-persisted
// in production since 2026-07-24 (deploy used to reset the in-memory counter,
// making the ceiling meaningless; the stored value is ONE aggregate number per
// user per window, never message content or per-message rows). The window is
// Tuesday 17:00 Europe/Warsaw (usageWindow). The burst cap stays in-memory —
// a per-minute bucket isn't worth a database round-trip.

import type { UsageStore } from "./usage.js";

export interface FreeTier {
  /** Max linked devices for an unentitled user (approve-time check). */
  devices: number;
  /** Max routed `send` prompts per user per usage window (usageWindow). */
  weeklyMsgs: number;
  usage: UsageStore;
}

export interface MessageRate {
  /** Max routed `send` prompts per user per calendar minute — all users. */
  perMinute: number;
  limiter: MinuteRateLimiter;
}

/**
 * Count the machines represented by linked device rows.
 *
 * The extension's bare id and the sanctioned desktop id (`<machine>:desktop`)
 * share a machine slot with their prefix. Unknown suffixes are individual
 * machines; they must never get to invent a sharing class. Until a sanctioned
 * discriminated id is present, preserve the historical row count exactly;
 * rows without an install id are always individual machines.
 */
function isDesktopInstallId(installId: string): boolean {
  const separator = installId.indexOf(":");
  return separator > 0 && installId.slice(separator + 1) === "desktop";
}

export function isRecognizedInstallId(installId: string): boolean {
  return !installId.includes(":") || isDesktopInstallId(installId);
}

export function countMachines(devices: ReadonlyArray<{ installId?: string }>): number {
  if (!devices.some((d) => d.installId !== undefined && isDesktopInstallId(d.installId))) {
    return devices.length;
  }

  const machines = new Set<string>();
  let individual = 0;
  for (const device of devices) {
    if (!device.installId) {
      individual += 1;
      continue;
    }
    if (!isRecognizedInstallId(device.installId)) {
      individual += 1;
      continue;
    }
    machines.add(device.installId.split(":", 1)[0]);
  }
  return individual + machines.size;
}

/** Per-id counter over time buckets; refusals never inflate the count. */
class BucketCounter {
  private counts = new Map<string, { bucket: string; count: number }>();
  private activeBucket: string | undefined;

  constructor(
    private readonly now: () => number,
    private readonly bucket: (t: number) => string,
  ) {}

  /** Roll all ids into the current bucket lazily. Since every entry was
   *  created through this method, a bucket change makes the whole map stale. */
  private currentBucket(): string {
    const bucket = this.bucket(this.now());
    if (bucket !== this.activeBucket) {
      this.counts.clear();
      this.activeBucket = bucket;
    }
    return bucket;
  }

  /** Try to spend one unit for id. True = within the limit (spent). */
  take(id: string, limit: number): boolean {
    const bucket = this.currentBucket();
    const entry = this.counts.get(id);
    if (!entry) {
      if (limit < 1) return false;
      this.counts.set(id, { bucket, count: 1 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  used(id: string): number {
    const bucket = this.currentBucket();
    const entry = this.counts.get(id);
    return entry && entry.bucket === bucket ? entry.count : 0;
  }

  /** Number of identities retained in the active bucket. */
  trackedIds(): number {
    this.currentBucket();
    return this.counts.size;
  }
}

export class MinuteRateLimiter extends BucketCounter {
  constructor(now: () => number) {
    super(now, (t) => String(Math.floor(t / 60000)));
  }
}
