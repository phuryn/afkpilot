// In-memory memo of devices.verify() LOOKUPS — the row, never the verdict.
//
// /uplink calls verify() on every WebSocket upgrade. A host whose socket opens
// and dies shortly after retries about once a second, and each attempt is one
// database round-trip. This cache turns that storm into one query per TTL.
//
// Security: the cache stores kid → {hmac, record} (or a negative miss). Every
// caller still recomputes HMAC(pepper, userId + presented secret) and compares
// it to the cached hmac. Caching "this token is valid" would accept a wrong
// secret on the next hit — a credential bypass. Do not add a verdict field.
//
// In-memory only. No tables, no columns, nothing persisted. Bound and TTL'd
// so a unique-kid flood cannot grow without limit.

import type { DeviceRecord } from "./devices.js";

/** Positive-row TTL. Single-digit seconds: absorb a reconnect storm, not remember. */
export const VERIFY_CACHE_TTL_MS = 5_000;
/** Negative (no row) TTL. Shorter — a revoked device retrying is the storm shape. */
export const VERIFY_CACHE_NEGATIVE_TTL_MS = 2_000;
/** Hard cap. LRU eviction once full; expired entries are dropped on the way. */
export const VERIFY_CACHE_MAX_ENTRIES = 4_096;

/** What verify() may reuse: the stored MAC and the public record. Never a secret. */
export interface CachedVerifyEntry {
  hmac: string;
  record: DeviceRecord;
}

interface Slot {
  expiresAt: number;
  value: CachedVerifyEntry | null;
}

export interface DeviceVerifyCacheDeps {
  now: () => number;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
}

export class DeviceVerifyCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly byKid = new Map<string, Slot>();

  constructor(deps: DeviceVerifyCacheDeps) {
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? VERIFY_CACHE_TTL_MS;
    this.negativeTtlMs = deps.negativeTtlMs ?? VERIFY_CACHE_NEGATIVE_TTL_MS;
    this.maxEntries = deps.maxEntries ?? VERIFY_CACHE_MAX_ENTRIES;
  }

  /**
   * `undefined` = miss (go to the database).
   * `null` = cached negative (no live row for this kid).
   * an entry = cached row; the caller MUST still check the presented secret.
   */
  get(kid: string): CachedVerifyEntry | null | undefined {
    const slot = this.byKid.get(kid);
    if (!slot) return undefined;
    if (slot.expiresAt <= this.now()) {
      this.byKid.delete(kid);
      return undefined;
    }
    // LRU: reinsert so a hot reconnecting kid is last to evict.
    this.byKid.delete(kid);
    this.byKid.set(kid, slot);
    if (slot.value === null) return null;
    return cloneEntry(slot.value);
  }

  set(kid: string, value: CachedVerifyEntry | null): void {
    this.byKid.delete(kid);
    this.evictIfNeeded();
    const ttl = value === null ? this.negativeTtlMs : this.ttlMs;
    this.byKid.set(kid, {
      expiresAt: this.now() + ttl,
      value: value === null ? null : cloneEntry(value),
    });
  }

  invalidateKid(kid: string): void {
    this.byKid.delete(kid);
  }

  /** Drop every cached row for this device. Used on revoke (keyed by deviceId). */
  invalidateDevice(deviceId: string): void {
    for (const [kid, slot] of this.byKid) {
      if (slot.value && slot.value.record.deviceId === deviceId) {
        this.byKid.delete(kid);
      }
    }
  }

  size(): number {
    return this.byKid.size;
  }

  private evictIfNeeded(): void {
    if (this.byKid.size < this.maxEntries) return;
    const now = this.now();
    for (const [kid, slot] of this.byKid) {
      if (slot.expiresAt <= now) this.byKid.delete(kid);
      if (this.byKid.size < this.maxEntries) return;
    }
    if (this.byKid.size < this.maxEntries) return;
    const oldest = this.byKid.keys().next().value;
    if (oldest !== undefined) this.byKid.delete(oldest);
  }
}

function cloneEntry(entry: CachedVerifyEntry): CachedVerifyEntry {
  return { hmac: entry.hmac, record: { ...entry.record } };
}
