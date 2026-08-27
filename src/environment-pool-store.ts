/**
 * Where the shelf is kept.
 *
 * Split from `environment-store.ts` because it answers a different question. An
 * environment belongs to somebody and the relay's only job with it is to wake
 * it. A pooled sprite belongs to NOBODY — that is the whole point — and the
 * only questions are how many there are and which one to hand over next.
 *
 * The claim is the part that has to be right, and it is not implemented here:
 * it is a SQL function (`claim_pool_sprite`) so that selecting a row and
 * marking it taken happen in one statement under `FOR UPDATE SKIP LOCKED`.
 * Reading `ready` in one call and writing `claimed` in another is a race with a
 * comfortable window, and losing it means two people are handed the same
 * machine.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUILD_TIMEOUT_MS, type PoolCounts } from "./environment-pool.js";

export interface PoolEntry {
  externalId: string;
  provider: "sprite";
  state: "building" | "ready" | "claimed" | "failed";
  createdAt: number;
  readyAt: number | null;
  note?: string;
}

export interface EnvironmentPoolStore {
  /**
   * Ready and in-flight counts, with stale builds excluded from `building`.
   *
   * Excluded rather than merely reported, because the filler subtracts this
   * from its target: a build nobody will ever finish, still counted, is a slot
   * that never gets refilled.
   */
  counts(now: number, timeoutMs?: number): Promise<PoolCounts>;
  /** Record a build we are about to start. */
  add(externalId: string, claimSecret: string): Promise<boolean>;
  /**
   * The sprite reporting that its install finished.
   *
   * `ready` is a claim the machine makes, because a ~25-minute install is not
   * something the relay sits and watches. The secret proves the claim came from
   * the sprite we built rather than from someone who guessed a name and would
   * have handed a user a half-built box.
   */
  markReady(externalId: string, claimSecret: string, now: number): Promise<boolean>;
  /** Take one off the shelf, atomically. Null when the shelf is empty. */
  claim(): Promise<{ externalId: string; provider: "sprite" } | null>;
  /** Forget a row — after its environment row is written, or after a scrap. */
  remove(externalId: string): Promise<boolean>;
  /**
   * Builds past believing in. READ ONLY — it names them, it does not bury them.
   *
   * Split from marking on purpose. A scrapped build still has a machine behind
   * it, and a row marked `failed` before that machine is destroyed is a sprite
   * nothing will ever look at again: the row no longer counts toward the target,
   * so no sweep revisits it, and the bill runs forever. Naming and burying are
   * separate so the sweep can destroy FIRST and mark only on success — and
   * retry the whole thing next time if the provider was having a bad minute.
   */
  staleBuilds(now: number, timeoutMs?: number): Promise<string[]>;
  /** Bury one, once its machine is actually gone. */
  markFailed(externalId: string, note: string): Promise<boolean>;
}

export class InMemoryEnvironmentPoolStore implements EnvironmentPoolStore {
  private rows = new Map<string, PoolEntry & { claimSecret: string }>();

  constructor(private readonly now: () => number = Date.now) {}

  async counts(now: number, timeoutMs = BUILD_TIMEOUT_MS): Promise<PoolCounts> {
    let ready = 0;
    let building = 0;
    for (const r of this.rows.values()) {
      if (r.state === "ready") ready += 1;
      else if (r.state === "building" && now - r.createdAt < timeoutMs) building += 1;
    }
    return { ready, building };
  }

  async add(externalId: string, claimSecret: string): Promise<boolean> {
    if (this.rows.has(externalId)) return false;
    this.rows.set(externalId, {
      externalId, provider: "sprite", state: "building",
      createdAt: this.now(), readyAt: null, claimSecret,
    });
    return true;
  }

  async markReady(externalId: string, claimSecret: string, now: number): Promise<boolean> {
    const row = this.rows.get(externalId);
    if (!row || row.state !== "building" || row.claimSecret !== claimSecret) return false;
    row.state = "ready";
    row.readyAt = now;
    return true;
  }

  async claim(): Promise<{ externalId: string; provider: "sprite" } | null> {
    // Single-threaded here, so the ordering is all that needs to match: oldest
    // ready first, so a machine parked longest gets used rather than ageing on
    // the shelf forever.
    const ready = [...this.rows.values()]
      .filter((r) => r.state === "ready")
      .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0));
    const row = ready[0];
    if (!row) return null;
    row.state = "claimed";
    return { externalId: row.externalId, provider: row.provider };
  }

  async remove(externalId: string): Promise<boolean> {
    return this.rows.delete(externalId);
  }

  async staleBuilds(now: number, timeoutMs = BUILD_TIMEOUT_MS): Promise<string[]> {
    return [...this.rows.values()]
      .filter((r) => r.state === "building" && now - r.createdAt >= timeoutMs)
      .map((r) => r.externalId);
  }

  async markFailed(externalId: string, note: string): Promise<boolean> {
    const row = this.rows.get(externalId);
    if (!row || row.state !== "building") return false;
    row.state = "failed";
    row.note = note;
    return true;
  }
}

interface PoolRow {
  external_id: string;
  provider: string;
  state: PoolEntry["state"];
  created_at: string;
  ready_at: string | null;
}

export class SupabaseEnvironmentPoolStore implements EnvironmentPoolStore {
  constructor(private readonly db: SupabaseClient) {}

  async counts(now: number, timeoutMs = BUILD_TIMEOUT_MS): Promise<PoolCounts> {
    const cutoff = new Date(now - timeoutMs).toISOString();
    const ready = await this.db
      .from("environment_pool").select("external_id", { count: "exact", head: true })
      .eq("state", "ready");
    const building = await this.db
      .from("environment_pool").select("external_id", { count: "exact", head: true })
      .eq("state", "building").gt("created_at", cutoff);
    return {
      ready: ready.error ? 0 : (ready.count ?? 0),
      building: building.error ? 0 : (building.count ?? 0),
    };
  }

  async add(externalId: string, claimSecret: string): Promise<boolean> {
    const { error } = await this.db.from("environment_pool").insert({
      external_id: externalId, provider: "sprite", state: "building", claim_secret: claimSecret,
    });
    return !error;
  }

  async markReady(externalId: string, claimSecret: string, now: number): Promise<boolean> {
    // Both the name and the secret, and only from `building`: a replayed report
    // must not move a claimed machine back onto the shelf while somebody is
    // using it.
    const { data, error } = await this.db
      .from("environment_pool")
      .update({ state: "ready", ready_at: new Date(now).toISOString() })
      .eq("external_id", externalId)
      .eq("claim_secret", claimSecret)
      .eq("state", "building")
      .select("external_id");
    return !error && !!data && data.length > 0;
  }

  async claim(): Promise<{ externalId: string; provider: "sprite" } | null> {
    const { data, error } = await this.db.rpc("claim_pool_sprite");
    if (error || !data) return null;
    const rows = data as unknown as { external_id: string; provider: string }[];
    const row = rows[0];
    if (!row) return null;
    return { externalId: row.external_id, provider: "sprite" };
  }

  async remove(externalId: string): Promise<boolean> {
    const { error } = await this.db
      .from("environment_pool").delete().eq("external_id", externalId);
    return !error;
  }

  async staleBuilds(now: number, timeoutMs = BUILD_TIMEOUT_MS): Promise<string[]> {
    const cutoff = new Date(now - timeoutMs).toISOString();
    const { data, error } = await this.db
      .from("environment_pool")
      .select("external_id")
      .eq("state", "building")
      .lte("created_at", cutoff);
    if (error || !data) return [];
    return (data as unknown as { external_id: string }[]).map((r) => r.external_id);
  }

  async markFailed(externalId: string, note: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("environment_pool")
      .update({ state: "failed", note })
      .eq("external_id", externalId)
      .eq("state", "building")
      .select("external_id");
    return !error && !!data && data.length > 0;
  }
}
