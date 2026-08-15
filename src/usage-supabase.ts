// Supabase-persisted UsageStore (the production side of the seam).
//
// One aggregate count per user + Warsaw usage window; no message content or
// per-message metadata. Schema: supabase/migrations/ — RLS on with no policies,
// so only the relay's secret key reaches the table and increment RPC.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageStore } from "./usage.js";

export class SupabaseUsageStore implements UsageStore {
  constructor(private readonly db: SupabaseClient) {}

  async increment(userId: string, windowStartMs: number): Promise<number> {
    const { data, error } = await this.db.rpc("increment_usage", {
      p_user_id: userId,
      p_window_start: new Date(windowStartMs).toISOString(),
    });
    if (error) throw new Error(`usage increment failed: ${error.message}`);
    const count = Number(data);
    if (!Number.isInteger(count)) throw new Error("usage increment failed: invalid count");
    return count;
  }

  async peek(userId: string, windowStartMs: number): Promise<number> {
    const { data, error } = await this.db
      .from("usage_counters")
      .select("count")
      .eq("user_id", userId)
      .eq("window_start", new Date(windowStartMs).toISOString())
      .maybeSingle();
    if (error) throw new Error(`usage lookup failed: ${error.message}`);
    return data ? Number((data as { count: number }).count) : 0;
  }
}
