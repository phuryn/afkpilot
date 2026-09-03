import { describe, expect, it } from "vitest";
import {
  DeviceVerifyCache,
  type CachedVerifyEntry,
} from "../src/device-verify-cache.js";
import { hmacDeviceSecret, parseDeviceToken, safeEqual } from "../src/device-keys.js";
import type { DeviceRecord } from "../src/devices.js";

const PEPPER = "test-pepper";
const KID = "kid-1";
const SECRET = "correct-secret";
const TOKEN = `sk-device-${KID}.${SECRET}`;
const WRONG_TOKEN = `sk-device-${KID}.wrong-secret`;

const record: DeviceRecord = {
  deviceId: "dev-1",
  userId: "user-1",
  name: "Laptop",
  createdAt: 1_700_000_000_000,
};

const entry: CachedVerifyEntry = {
  hmac: hmacDeviceSecret(record.userId, SECRET, PEPPER),
  record,
};

function cacheAt(clock: { t: number }, opts?: { ttlMs?: number; negativeTtlMs?: number; maxEntries?: number }) {
  return new DeviceVerifyCache({
    now: () => clock.t,
    ttlMs: opts?.ttlMs ?? 5_000,
    negativeTtlMs: opts?.negativeTtlMs ?? 2_000,
    maxEntries: opts?.maxEntries ?? 4,
  });
}

/**
 * The verify shape the cache exists to serve: look up the ROW (cached), then
 * always recompute the MAC against the PRESENTED secret. This is the contract
 * devices-supabase.ts must keep; the tests below pin it without a database.
 */
function verify(
  cache: DeviceVerifyCache,
  token: string,
  lookup: (kid: string) => CachedVerifyEntry | null,
): DeviceRecord | null {
  const parsed = parseDeviceToken(token);
  if (!parsed) return null;
  let cached = cache.get(parsed.kid);
  if (cached === undefined) {
    cached = lookup(parsed.kid);
    cache.set(parsed.kid, cached);
  }
  if (!cached) return null;
  const expected = hmacDeviceSecret(cached.record.userId, parsed.secret, PEPPER);
  if (!safeEqual(expected, cached.hmac)) return null;
  return cached.record;
}

describe("verify uses the cached ROW, never a cached verdict", () => {
  it("a wrong secret still fails on a cache hit", () => {
    const clock = { t: 0 };
    const cache = cacheAt(clock);
    let lookups = 0;
    const lookup = (kid: string) => {
      lookups += 1;
      expect(kid).toBe(KID);
      return entry;
    };

    expect(verify(cache, TOKEN, lookup)).toMatchObject({ deviceId: "dev-1" });
    expect(lookups).toBe(1);

    // Same kid, wrong secret: the row is reused, the MAC is still checked.
    expect(verify(cache, WRONG_TOKEN, lookup)).toBeNull();
    expect(lookups).toBe(1);

    // And the right secret still works on that same cached row.
    expect(verify(cache, TOKEN, lookup)).toMatchObject({ deviceId: "dev-1" });
    expect(lookups).toBe(1);
  });

  it("caches the row even when the first presented secret is wrong", () => {
    const clock = { t: 0 };
    const cache = cacheAt(clock);
    let lookups = 0;
    const lookup = () => {
      lookups += 1;
      return entry;
    };
    expect(verify(cache, WRONG_TOKEN, lookup)).toBeNull();
    expect(lookups).toBe(1);
    expect(verify(cache, WRONG_TOKEN, lookup)).toBeNull();
    expect(lookups).toBe(1);
    expect(verify(cache, TOKEN, lookup)).toMatchObject({ deviceId: "dev-1" });
    expect(lookups).toBe(1);
  });
});

describe("DeviceVerifyCache", () => {
  it("misses until set, then hits", () => {
    const cache = cacheAt({ t: 0 });
    expect(cache.get(KID)).toBeUndefined();
    cache.set(KID, entry);
    expect(cache.get(KID)).toEqual(entry);
    expect(cache.get(KID)?.hmac).toBe(entry.hmac);
  });

  it("treats a cached negative as a hit, distinct from a miss", () => {
    const cache = cacheAt({ t: 0 });
    cache.set(KID, null);
    expect(cache.get(KID)).toBeNull();
    expect(cache.get("other")).toBeUndefined();
  });

  it("expires a positive row after its TTL", () => {
    const clock = { t: 1_000 };
    const cache = cacheAt(clock, { ttlMs: 5_000 });
    cache.set(KID, entry);
    clock.t = 1_000 + 5_000;
    expect(cache.get(KID)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("expires a negative faster than a positive", () => {
    const clock = { t: 0 };
    const cache = cacheAt(clock, { ttlMs: 5_000, negativeTtlMs: 2_000 });
    cache.set("pos", entry);
    cache.set("neg", null);
    clock.t = 2_000;
    expect(cache.get("neg")).toBeUndefined();
    expect(cache.get("pos")).toEqual(entry);
  });

  it("evicts the least-recently-used kid once the cap is reached", () => {
    const cache = cacheAt({ t: 0 }, { maxEntries: 2 });
    cache.set("a", entry);
    cache.set("b", entry);
    cache.get("a"); // a is now newer than b
    cache.set("c", entry);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(entry);
    expect(cache.get("c")).toEqual(entry);
    expect(cache.size()).toBe(2);
  });

  it("drops expired entries before falling back to LRU", () => {
    const clock = { t: 0 };
    const cache = cacheAt(clock, { ttlMs: 5_000, maxEntries: 2 });
    cache.set("old", entry);
    clock.t = 5_000;
    cache.set("fresh", entry);
    cache.set("newer", entry);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("fresh")).toEqual(entry);
    expect(cache.get("newer")).toEqual(entry);
  });

  it("invalidateKid drops that kid immediately", () => {
    const cache = cacheAt({ t: 0 });
    cache.set(KID, entry);
    cache.invalidateKid(KID);
    expect(cache.get(KID)).toBeUndefined();
  });

  it("invalidateDevice drops every cached row for that device", () => {
    const cache = cacheAt({ t: 0 });
    cache.set(KID, entry);
    cache.set("other", {
      hmac: "x",
      record: { ...record, deviceId: "dev-2" },
    });
    cache.invalidateDevice("dev-1");
    expect(cache.get(KID)).toBeUndefined();
    expect(cache.get("other")?.record.deviceId).toBe("dev-2");
  });

  it("returns clones, so a caller cannot mutate the cached hmac", () => {
    const cache = cacheAt({ t: 0 });
    cache.set(KID, entry);
    const got = cache.get(KID)!;
    got.hmac = "tampered";
    got.record.name = "mutated";
    expect(cache.get(KID)).toEqual(entry);
  });
});
