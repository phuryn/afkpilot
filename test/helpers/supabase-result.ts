import type { SupabaseClient } from "@supabase/supabase-js";

/** PostgREST returns error objects rather than rejecting the query promise. */
export function supabaseResult(result: (state?: string) => object): SupabaseClient {
  return {
    from: () => {
      let state: string | undefined;
      const query = {
        select() { return query; },
        eq(column: string, value: string) { if (column === "state") state = value; return query; },
        gt() { return query; },
        then(resolve: (value: object) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve(result(state)).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}
