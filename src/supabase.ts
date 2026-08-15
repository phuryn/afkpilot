// supabase-js client factory for the relay. Node 20 has no native WebSocket,
// and SupabaseClient constructs its realtime client eagerly — so we hand it
// the ws package as transport even though the relay never uses realtime.
// persistSession off: the secret key is a server credential, not a user session.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

export function createDb(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket as unknown as new (...args: unknown[]) => globalThis.WebSocket },
  });
}
