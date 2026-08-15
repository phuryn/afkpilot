// Real-Supabase round trip for SupabaseUsageStore. Runs only with the .env
// credentials (like the device-registry live test) AND only once the
// usage_counters migration has been applied to that database — it probes for
// the table and skips only when the table is absent, so the suite stays green
// in the window between this code landing on main and the GitHub integration
// applying the migration. Other probe failures remain visible test failures.
// Cleans up its own rows (user prefix "itest-").

import { describe, it, expect, afterAll } from "vitest";
import { createDb } from "../src/supabase.js";
import { SupabaseUsageStore } from "../src/usage-supabase.js";
import { usageWindow } from "../src/usage.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const db = url && key ? createDb(url, key) : null;

async function hasUsageCounters(): Promise<boolean> {
  if (!db) return false;

  const { error } = await db.from("usage_counters").select("user_id").limit(1);
  if (!error) return true;

  if (error.code === "PGRST205" || error.code === "42P01") {
    console.log(`[usage live test] skipped — usage_counters not migrated yet: ${error.message}`);
    return false;
  }

  throw new Error(
    `[usage live test] database probe failed (${error.code || "no error code"}): ${error.message}`,
  );
}

const migrated = await hasUsageCounters();

afterAll(async () => {
  if (db && migrated) await db.from("usage_counters").delete().like("user_id", "itest-%");
});

describe.skipIf(!migrated)("SupabaseUsageStore (real db)", () => {
  it("increments atomically, peeks, and lazily drops older windows", async () => {
    const s = new SupabaseUsageStore(db!);
    const user = `itest-${Date.now()}`;
    const { start } = usageWindow(Date.now());

    expect(await s.peek(user, start)).toBe(0);
    expect(await s.increment(user, start)).toBe(1);
    expect(await s.increment(user, start)).toBe(2);
    expect(await s.peek(user, start)).toBe(2);

    // A NEWER window's first increment drops the old row (the lazy reset).
    const nextWindow = start + 7 * 86400_000;
    expect(await s.increment(user, nextWindow)).toBe(1);
    expect(await s.peek(user, start)).toBe(0);
  });
});
