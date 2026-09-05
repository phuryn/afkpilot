import { describe, expect, it } from "vitest";
import { SupabaseEnvironmentStore } from "../src/environment-store";
import { supabaseResult } from "./helpers/supabase-result";

describe("Supabase environment inventory", () => {
  it("throws on a returned query error instead of claiming the user has no machine (C6)", async () => {
    const store = new SupabaseEnvironmentStore(supabaseResult(() => ({
      data: null, error: { message: "read failed" },
    })));
    await expect(store.listByUser("user")).rejects.toThrow("read failed");
  });

  it("distinguishes a successful empty list from a missing response", async () => {
    const empty = new SupabaseEnvironmentStore(supabaseResult(() => ({ data: [], error: null })));
    expect(await empty.listByUser("user")).toEqual([]);
    const missing = new SupabaseEnvironmentStore(supabaseResult(() => ({ data: null, error: null })));
    await expect(missing.listByUser("user")).rejects.toThrow("no data");
  });
});
