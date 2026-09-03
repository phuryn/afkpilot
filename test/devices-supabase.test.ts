// Stub-client unit tests for SupabaseDeviceRegistry's server-side queries.
// The eq() assertions are the regression pin: a fetch-all-then-filter-in-JS
// list() would not put user_id / device_id on the builder, and these fail.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseDeviceRegistry } from "../src/devices-supabase.js";
import { DeviceVerifyCache } from "../src/device-verify-cache.js";
import { hmacDeviceSecret, issueDeviceKey } from "../src/device-keys.js";

interface Call {
  method: string;
  args: unknown[];
}

function recordingClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === "maybeSingle" || method === "single") return Promise.resolve(result);
    return builder;
  };
  builder.select = record("select");
  builder.insert = record("insert");
  builder.update = record("update");
  builder.eq = record("eq");
  builder.is = record("is");
  builder.order = record("order");
  builder.maybeSingle = record("maybeSingle");
  builder.single = record("single");
  // PostgREST builders are thenable — listByUser awaits the chain without maybeSingle.
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  const from = (table: string) => {
    calls.push({ method: "from", args: [table] });
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const deps = {
  now: () => 0,
  randomUUID: () => "unused",
  randomBytes: () => Buffer.alloc(0),
  pepper: "test-pepper",
};

// UUID-shaped like every real device_id (gen_random_uuid()) — findOwned
// screens non-UUID ids before querying, so non-UUID fixtures would silently
// bypass the code under test.
const DEV_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const MISSING_ID = "0b41e1d0-92cf-46a4-9a1d-4b1e6f2b3c4d";

const row = {
  device_id: DEV_ID,
  user_id: "user-1",
  name: "Laptop",
  created_at: "2026-01-01T00:00:00.000Z",
  install_id: "inst-1",
};

describe("SupabaseDeviceRegistry (stub client)", () => {
  it("listByUser filters user_id and revoked_at server-side, ordered by created_at", async () => {
    const { client, calls } = recordingClient({ data: [row], error: null });
    const recs = await new SupabaseDeviceRegistry(client, deps).listByUser("user-1");
    expect(calls.filter((c) => c.method === "eq")).toEqual([{ method: "eq", args: ["user_id", "user-1"] }]);
    expect(calls).toContainEqual({ method: "is", args: ["revoked_at", null] });
    expect(calls).toContainEqual({ method: "order", args: ["created_at", { ascending: true }] });
    expect(calls.some((c) => c.method === "maybeSingle")).toBe(false);
    expect(recs).toEqual([
      { deviceId: DEV_ID, userId: "user-1", name: "Laptop", createdAt: Date.parse(row.created_at), installId: "inst-1" },
    ]);
  });

  it("findOwned filters device_id AND user_id server-side via maybeSingle", async () => {
    const { client, calls } = recordingClient({ data: row, error: null });
    const rec = await new SupabaseDeviceRegistry(client, deps).findOwned(DEV_ID, "user-1");
    expect(calls.filter((c) => c.method === "eq")).toEqual([
      { method: "eq", args: ["device_id", DEV_ID] },
      { method: "eq", args: ["user_id", "user-1"] },
    ]);
    expect(calls).toContainEqual({ method: "is", args: ["revoked_at", null] });
    expect(calls.some((c) => c.method === "maybeSingle")).toBe(true);
    expect(rec).toEqual({
      deviceId: DEV_ID,
      userId: "user-1",
      name: "Laptop",
      createdAt: Date.parse(row.created_at),
      installId: "inst-1",
    });
  });

  it("findOwned returns null when no row matches", async () => {
    const { client, calls } = recordingClient({ data: null, error: null });
    expect(await new SupabaseDeviceRegistry(client, deps).findOwned(MISSING_ID, "user-1")).toBeNull();
    expect(calls.filter((c) => c.method === "eq")).toEqual([
      { method: "eq", args: ["device_id", MISSING_ID] },
      { method: "eq", args: ["user_id", "user-1"] },
    ]);
  });

  it("listByUser maps client metadata when the row has it", async () => {
    const withClient = {
      ...row,
      client_label: "Cursor",
      platform: "mac",
      os_label: "macOS Sequoia",
    };
    const { client } = recordingClient({ data: [withClient], error: null });
    const recs = await new SupabaseDeviceRegistry(client, deps).listByUser("user-1");
    expect(recs).toEqual([
      {
        deviceId: DEV_ID,
        userId: "user-1",
        name: "Laptop",
        createdAt: Date.parse(row.created_at),
        installId: "inst-1",
        clientLabel: "Cursor",
        platform: "mac",
        osLabel: "macOS Sequoia",
      },
    ]);
  });

  it("issue inserts client metadata columns (null when absent)", async () => {
    const { client, calls } = recordingClient({ data: { device_id: DEV_ID }, error: null });
    const registry = new SupabaseDeviceRegistry(client, {
      now: () => 0,
      randomUUID: () => "kid-1",
      randomBytes: (n) => Buffer.alloc(n, 7),
      pepper: "test-pepper",
    });
    await registry.issue("Laptop", "user-1", "inst-1", {
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(calls.find((c) => c.method === "insert")?.args[0]).toMatchObject({
      user_id: "user-1",
      name: "Laptop",
      install_id: "inst-1",
      client_label: "VS Code extension",
      platform: "win",
      os_label: "Windows 11",
    });

    const { client: bareClient, calls: bareCalls } = recordingClient({
      data: { device_id: DEV_ID },
      error: null,
    });
    await new SupabaseDeviceRegistry(bareClient, {
      now: () => 0,
      randomUUID: () => "kid-2",
      randomBytes: (n) => Buffer.alloc(n, 3),
      pepper: "test-pepper",
    }).issue("Old box", "user-1");
    expect(bareCalls.find((c) => c.method === "insert")?.args[0]).toMatchObject({
      client_label: null,
      platform: null,
      os_label: null,
    });
  });

  it("updateClient patches only client columns, filtered by device_id", async () => {
    const { client, calls } = recordingClient({ data: null, error: null });
    await new SupabaseDeviceRegistry(client, deps).updateClient(DEV_ID, {
      clientLabel: "Cursor",
      platform: "mac",
      osLabel: "macOS Sequoia",
    });
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      client_label: "Cursor",
      platform: "mac",
      os_label: "macOS Sequoia",
    });
    expect(calls.filter((c) => c.method === "eq")).toEqual([{ method: "eq", args: ["device_id", DEV_ID] }]);
    expect(JSON.stringify(calls)).not.toMatch(/"name"/);
    expect(JSON.stringify(calls)).not.toMatch(/user_id/);
  });

  it("a wrong secret still fails on a cache hit", async () => {
    const minted = issueDeviceKey({
      randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      randomBytes: (n) => Buffer.alloc(n, 9),
    });
    const hmac = hmacDeviceSecret("user-1", minted.secret, deps.pepper);
    const verifyRow = { ...row, hmac };
    const { client, calls } = recordingClient({ data: verifyRow, error: null });
    const cache = new DeviceVerifyCache({ now: () => 0, ttlMs: 5_000, maxEntries: 8 });
    const registry = new SupabaseDeviceRegistry(client, { ...deps, verifyCache: cache });

    expect(await registry.verify(minted.token)).toMatchObject({ deviceId: DEV_ID, userId: "user-1" });
    const dbHits = () => calls.filter((c) => c.method === "maybeSingle").length;
    expect(dbHits()).toBe(1);

    const wrong = `sk-device-${minted.kid}.not-the-secret`;
    expect(await registry.verify(wrong)).toBeNull();
    expect(dbHits()).toBe(1);

    expect(await registry.verify(minted.token)).toMatchObject({ deviceId: DEV_ID });
    expect(dbHits()).toBe(1);
  });

  it("verify reuses a cached row and caches a negative miss", async () => {
    const minted = issueDeviceKey({
      randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      randomBytes: (n) => Buffer.alloc(n, 9),
    });
    const hmac = hmacDeviceSecret("user-1", minted.secret, deps.pepper);
    const { client, calls } = recordingClient({ data: { ...row, hmac }, error: null });
    const cache = new DeviceVerifyCache({ now: () => 0, ttlMs: 5_000, maxEntries: 8 });
    const registry = new SupabaseDeviceRegistry(client, { ...deps, verifyCache: cache });

    await registry.verify(minted.token);
    await registry.verify(minted.token);
    expect(calls.filter((c) => c.method === "maybeSingle")).toHaveLength(1);

    const { client: missClient, calls: missCalls } = recordingClient({ data: null, error: null });
    const missCache = new DeviceVerifyCache({ now: () => 0, ttlMs: 5_000, negativeTtlMs: 2_000, maxEntries: 8 });
    const missRegistry = new SupabaseDeviceRegistry(missClient, { ...deps, verifyCache: missCache });
    const missing = `sk-device-missing-kid.${minted.secret}`;
    expect(await missRegistry.verify(missing)).toBeNull();
    expect(await missRegistry.verify(missing)).toBeNull();
    expect(missCalls.filter((c) => c.method === "maybeSingle")).toHaveLength(1);
  });

  it("revoke drops the cached row so the token dies immediately", async () => {
    const minted = issueDeviceKey({
      randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      randomBytes: (n) => Buffer.alloc(n, 9),
    });
    const hmac = hmacDeviceSecret("user-1", minted.secret, deps.pepper);
    const verifyRow = { ...row, hmac };
    const { client } = recordingClient({ data: verifyRow, error: null });
    const cache = new DeviceVerifyCache({ now: () => 0, ttlMs: 5_000, maxEntries: 8 });
    const registry = new SupabaseDeviceRegistry(client, { ...deps, verifyCache: cache });
    expect(await registry.verify(minted.token)).toMatchObject({ deviceId: DEV_ID });

    const { client: revokeClient } = recordingClient({ data: [{ device_id: DEV_ID }], error: null });
    const revoking = new SupabaseDeviceRegistry(revokeClient, { ...deps, verifyCache: cache });
    expect(await revoking.revoke(DEV_ID)).toBe(true);

    const { client: afterClient, calls: afterCalls } = recordingClient({ data: null, error: null });
    const after = new SupabaseDeviceRegistry(afterClient, { ...deps, verifyCache: cache });
    expect(await after.verify(minted.token)).toBeNull();
    expect(afterCalls.filter((c) => c.method === "maybeSingle")).toHaveLength(1);
  });

  it("malformed tokens never hit the cache or the database", async () => {
    const { client, calls } = recordingClient({ data: row, error: null });
    const cache = new DeviceVerifyCache({ now: () => 0 });
    const registry = new SupabaseDeviceRegistry(client, { ...deps, verifyCache: cache });
    expect(await registry.verify("not-a-token")).toBeNull();
    expect(await registry.verify("")).toBeNull();
    expect(calls).toEqual([]);
    expect(cache.size()).toBe(0);
  });

  it("findOwned refuses a malformed device id without touching the database", async () => {
    // device_id is a uuid column — an unscreened non-UUID id would make
    // Postgres reject the cast, turning 404/4003 refusals into 500/1011.
    const { client, calls } = recordingClient({ data: row, error: null });
    const registry = new SupabaseDeviceRegistry(client, deps);
    expect(await registry.findOwned("dev-missing", "user-1")).toBeNull();
    expect(await registry.findOwned("'; drop table devices; --", "user-1")).toBeNull();
    expect(await registry.findOwned("", "user-1")).toBeNull();
    expect(calls).toEqual([]);
  });
});
