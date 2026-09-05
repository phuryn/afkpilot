/**
 * Where cloud environments are kept — the persistence seam.
 *
 * Same shape as `devices.ts`: `server.ts` codes against the async interface,
 * `main.ts` picks the implementation. In-memory for keyless dev (so a
 * contributor can run the whole thing with no account), Supabase in production.
 *
 * The store tracks ownership, readiness and the next wake for provisioning,
 * reset and activity holds. No prompts, no routine names, no schedules beyond
 * a single timestamp.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EnvironmentProvider, EnvironmentRecord } from "./environments.js";

export interface EnvironmentStore {
  /** The environment for a device, or null when it is an ordinary machine. */
  find(deviceId: string): Promise<EnvironmentRecord | null>;
  /** Live environments for one user. Throws on read failure; [] means none. */
  listByUser(userId: string): Promise<EnvironmentRecord[]>;
  /** Register a device as a cloud environment. Idempotent on deviceId. */
  create(input: {
    deviceId: string;
    userId: string;
    provider: EnvironmentProvider;
    externalId: string;
  }): Promise<EnvironmentRecord>;
  /**
   * Record the host's next scheduled wake. `null` clears it.
   *
   * Scoped by userId as well as deviceId so a token for one account can never
   * schedule a wake on another's machine — the same rule `findOwned` follows in
   * the device registry.
   */
  setWakeAt(deviceId: string, userId: string, wakeAt: number | null): Promise<boolean>;
  /** Environments whose scheduled wake has passed. */
  dueForWake(now: number, limit: number): Promise<EnvironmentRecord[]>;
  /**
   * Record that this machine has linked for the first time.
   *
   * Idempotent and one-way: it is set when the uplink first connects and never
   * cleared, because the question it answers is "has this ever worked", not
   * "is it up now". The second question is what `online` already answers.
   */
  markReady(deviceId: string, now: number): Promise<boolean>;
  remove(deviceId: string): Promise<boolean>;
}

/** Dev/no-keys implementation. Real enough to develop the whole flow against. */
export class InMemoryEnvironmentStore implements EnvironmentStore {
  private byDevice = new Map<string, EnvironmentRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  async find(deviceId: string): Promise<EnvironmentRecord | null> {
    return this.byDevice.get(deviceId) ?? null;
  }

  async listByUser(userId: string): Promise<EnvironmentRecord[]> {
    return [...this.byDevice.values()].filter((e) => e.userId === userId);
  }

  async create(input: {
    deviceId: string;
    userId: string;
    provider: EnvironmentProvider;
    externalId: string;
  }): Promise<EnvironmentRecord> {
    const existing = this.byDevice.get(input.deviceId);
    // Idempotent: re-registering keeps the schedule rather than silently
    // dropping a wake the host already asked for.
    const rec: EnvironmentRecord = {
      deviceId: input.deviceId,
      userId: input.userId,
      provider: input.provider,
      externalId: input.externalId,
      wakeAt: existing?.wakeAt ?? null,
      readyAt: existing?.readyAt ?? null,
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.byDevice.set(input.deviceId, rec);
    return rec;
  }

  async setWakeAt(deviceId: string, userId: string, wakeAt: number | null): Promise<boolean> {
    const rec = this.byDevice.get(deviceId);
    if (!rec || rec.userId !== userId) return false;
    this.byDevice.set(deviceId, { ...rec, wakeAt });
    return true;
  }

  async dueForWake(now: number, limit: number): Promise<EnvironmentRecord[]> {
    return [...this.byDevice.values()]
      .filter((e) => e.wakeAt !== null && e.wakeAt <= now)
      .sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0))
      .slice(0, limit);
  }

  async markReady(deviceId: string, now: number): Promise<boolean> {
    const rec = this.byDevice.get(deviceId);
    if (!rec || rec.readyAt !== null) return false;
    rec.readyAt = now;
    return true;
  }

  async remove(deviceId: string): Promise<boolean> {
    return this.byDevice.delete(deviceId);
  }
}

interface EnvironmentRow {
  device_id: string;
  user_id: string;
  provider: string;
  external_id: string;
  wake_at: string | null;
  ready_at: string | null;
  created_at: string;
}

const COLS = "device_id, user_id, provider, external_id, wake_at, ready_at, created_at";

const toRecord = (r: EnvironmentRow): EnvironmentRecord => ({
  deviceId: r.device_id,
  userId: r.user_id,
  // One provider exists, so there is nothing to branch on yet. Written as a
  // constant rather than a ternary that pretends to choose: a row from a newer
  // relay naming a provider this one has never heard of should be an explicit
  // decision when that day comes, not a silent coercion nobody notices.
  provider: "sprite",
  externalId: r.external_id,
  wakeAt: r.wake_at ? Date.parse(r.wake_at) : null,
  readyAt: r.ready_at ? Date.parse(r.ready_at) : null,
  createdAt: Date.parse(r.created_at),
});

export class SupabaseEnvironmentStore implements EnvironmentStore {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * `null` means there is no environment. An error THROWS.
   *
   * The two were the same answer once, and that is a fail-open: "this device is
   * not a cloud machine" is exactly what a database blip would say, and it is
   * the answer that unlinks a machine or admits a lapsed plan. Callers that can
   * safely guess are free to catch; the ones that cannot must not be told a
   * comfortable lie.
   */
  async find(deviceId: string): Promise<EnvironmentRecord | null> {
    const { data, error } = await this.db
      .from("environments").select(COLS).eq("device_id", deviceId).maybeSingle();
    if (error) throw new Error(`environments.find failed: ${error.message}`);
    if (!data) return null;
    return toRecord(data as unknown as EnvironmentRow);
  }

  async listByUser(userId: string): Promise<EnvironmentRecord[]> {
    const { data, error } = await this.db
      .from("environments").select(COLS).eq("user_id", userId);
    if (error || !data) throw new Error(`environments.listByUser failed: ${error?.message ?? "no data"}`);
    return (data as unknown as EnvironmentRow[]).map(toRecord);
  }

  async create(input: {
    deviceId: string;
    userId: string;
    provider: EnvironmentProvider;
    externalId: string;
  }): Promise<EnvironmentRecord> {
    const { data, error } = await this.db
      .from("environments")
      .upsert({
        device_id: input.deviceId,
        user_id: input.userId,
        provider: input.provider,
        external_id: input.externalId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "device_id" })
      .select(COLS)
      .single();
    if (error || !data) throw new Error(`environments.create failed: ${error?.message ?? "no row"}`);
    return toRecord(data as unknown as EnvironmentRow);
  }

  async setWakeAt(deviceId: string, userId: string, wakeAt: number | null): Promise<boolean> {
    const { data, error } = await this.db
      .from("environments")
      .update({ wake_at: wakeAt === null ? null : new Date(wakeAt).toISOString(), updated_at: new Date().toISOString() })
      .eq("device_id", deviceId)
      .eq("user_id", userId)
      .select("device_id");
    return !error && !!data && data.length > 0;
  }

  async dueForWake(now: number, limit: number): Promise<EnvironmentRecord[]> {
    const { data, error } = await this.db
      .from("environments")
      .select(COLS)
      .not("wake_at", "is", null)
      .lte("wake_at", new Date(now).toISOString())
      .order("wake_at", { ascending: true })
      .limit(limit);
    if (error || !data) return [];
    return (data as unknown as EnvironmentRow[]).map(toRecord);
  }

  async markReady(deviceId: string, now: number): Promise<boolean> {
    // `is null` guards the write as well as saving one: a machine that links
    // fifty times a day must not rewrite this row fifty times, and the first
    // link is the only one that means anything.
    const { data, error } = await this.db
      .from("environments")
      .update({ ready_at: new Date(now).toISOString(), updated_at: new Date().toISOString() })
      .eq("device_id", deviceId)
      .is("ready_at", null)
      .select("device_id");
    return !error && !!data && data.length > 0;
  }

  async remove(deviceId: string): Promise<boolean> {
    const { error } = await this.db.from("environments").delete().eq("device_id", deviceId);
    return !error;
  }
}
