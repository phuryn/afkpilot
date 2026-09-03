// Supabase-persisted DeviceRegistry (the production side of the seam).
//
// Stores only kid + hmac for each device token (sk-device-<kid>.<secret>) — the
// secret exists once, in the issue() response on its way to VS Code secrets, so
// a database leak exposes no usable credentials AND no offline-guessable hash:
// hmac = base64url(HMAC-SHA256(pepper, userId+secret)), keyed by a server-side
// pepper and bound to the owner's user id (see device-keys.ts). Revocation is a
// tombstone (revoked_at) for an audit trail. Schema: supabase/migrations/ — RLS on
// with no policies, so only the relay's secret key reaches the table. Message
// payloads never touch the db.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceClientInfo, DeviceRecord, DeviceRegistry } from "./devices.js";
import { isDevicePlatform } from "./device-client.js";
import { hmacDeviceSecret, issueDeviceKey, parseDeviceToken, safeEqual } from "./device-keys.js";
import type { CachedVerifyEntry, DeviceVerifyCache } from "./device-verify-cache.js";

interface DeviceRow {
  device_id: string;
  user_id: string;
  name: string;
  created_at: string;
  /** Null for rows written before the column existed — they never dedupe. */
  install_id: string | null;
  /** Null/absent for rows written before the client-metadata columns existed. */
  client_label?: string | null;
  platform?: string | null;
  os_label?: string | null;
}
interface VerifyRow extends DeviceRow {
  hmac: string;
}

const COLS = "device_id, user_id, name, created_at, install_id, client_label, platform, os_label";
const VERIFY_COLS = `${COLS}, hmac`;

/** gen_random_uuid() shapes — what every real device_id looks like. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toRecord = (r: DeviceRow): DeviceRecord => {
  const rec: DeviceRecord = {
    deviceId: r.device_id,
    userId: r.user_id,
    name: r.name,
    createdAt: Date.parse(r.created_at),
    installId: r.install_id ?? undefined,
  };
  if (r.client_label) rec.clientLabel = r.client_label;
  if (isDevicePlatform(r.platform)) rec.platform = r.platform;
  if (r.os_label) rec.osLabel = r.os_label;
  return rec;
};

export interface SupabaseDeviceRegistryDeps {
  now: () => number;
  randomUUID: () => string;
  randomBytes: (size: number) => Buffer;
  /** Server-side HMAC key for device secrets — required (main.ts exits without it). */
  pepper: string;
  /** Optional in-memory memo of verify() rows (not verdicts). Wired in main.ts. */
  verifyCache?: DeviceVerifyCache;
}

export class SupabaseDeviceRegistry implements DeviceRegistry {
  constructor(
    private readonly db: SupabaseClient,
    private readonly deps: SupabaseDeviceRegistryDeps,
  ) {}

  async issue(
    name: string,
    userId: string,
    installId?: string,
    client?: DeviceClientInfo,
  ): Promise<{ deviceId: string; token: string }> {
    const { kid, secret, token } = issueDeviceKey({ randomUUID: this.deps.randomUUID, randomBytes: this.deps.randomBytes });
    const hmac = hmacDeviceSecret(userId, secret, this.deps.pepper);
    const { data, error } = await this.db
      .from("devices")
      .insert({
        user_id: userId,
        name,
        kid,
        hmac,
        install_id: installId ?? null,
        client_label: client?.clientLabel ?? null,
        platform: client?.platform ?? null,
        os_label: client?.osLabel ?? null,
      })
      .select("device_id")
      .single();
    if (error) throw new Error(`devices insert failed: ${error.message}`);
    return { deviceId: (data as { device_id: string }).device_id, token };
  }

  async verify(token: string): Promise<DeviceRecord | null> {
    const parsed = parseDeviceToken(token);
    if (!parsed) return null; // malformed — no db hit
    const cache = this.deps.verifyCache;
    const cached = cache?.get(parsed.kid);
    if (cached !== undefined) return this.matchPresentedSecret(parsed.secret, cached);

    const { data, error } = await this.db
      .from("devices")
      .select(VERIFY_COLS)
      .eq("kid", parsed.kid)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw new Error(`devices lookup failed: ${error.message}`);
    const entry: CachedVerifyEntry | null = data
      ? { hmac: (data as VerifyRow).hmac, record: toRecord(data as VerifyRow) }
      : null;
    cache?.set(parsed.kid, entry);
    return this.matchPresentedSecret(parsed.secret, entry);
  }

  /**
   * Always run, cache hit or miss. The cache holds the row; this is the
   * verdict, and it is computed from the presented secret every time.
   */
  private matchPresentedSecret(secret: string, entry: CachedVerifyEntry | null): DeviceRecord | null {
    if (!entry) return null;
    const expected = hmacDeviceSecret(entry.record.userId, secret, this.deps.pepper);
    if (!safeEqual(expected, entry.hmac)) return null;
    return { ...entry.record };
  }

  async revoke(deviceId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("devices")
      .update({ revoked_at: new Date(this.deps.now()).toISOString() })
      .eq("device_id", deviceId)
      .is("revoked_at", null)
      .select("device_id");
    if (error) throw new Error(`devices revoke failed: ${error.message}`);
    this.deps.verifyCache?.invalidateDevice(deviceId);
    return (data?.length ?? 0) > 0;
  }

  // PostgREST caps unranged responses at 1000 rows. A global list() silently
  // truncated once production crossed that (issues #111/#112) — every caller
  // that fetched-all-then-filtered missed rows. These two queries filter
  // server-side so that class of bug cannot come back.
  async listByUser(userId: string): Promise<DeviceRecord[]> {
    const { data, error } = await this.db
      .from("devices")
      .select(COLS)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`devices listByUser failed: ${error.message}`);
    return ((data as DeviceRow[] | null) ?? []).map(toRecord);
  }

  async findOwned(deviceId: string, userId: string): Promise<DeviceRecord | null> {
    // device_id is a uuid column: a malformed id would make Postgres reject
    // the cast, turning a refusal (404 / close 4003) into a 500 / close 1011.
    // Screen the shape here so unknown and malformed ids refuse identically —
    // as the in-memory registry's string comparison always did — and skip the
    // round trip.
    if (!UUID_SHAPE.test(deviceId)) return null;
    const { data, error } = await this.db
      .from("devices")
      .select(COLS)
      .eq("device_id", deviceId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw new Error(`devices findOwned failed: ${error.message}`);
    if (!data) return null;
    return toRecord(data as DeviceRow);
  }

  async updateClient(deviceId: string, client: DeviceClientInfo): Promise<void> {
    const patch: { client_label?: string; platform?: string; os_label?: string } = {};
    if (client.clientLabel !== undefined) patch.client_label = client.clientLabel;
    if (client.platform !== undefined) patch.platform = client.platform;
    if (client.osLabel !== undefined) patch.os_label = client.osLabel;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.db.from("devices").update(patch).eq("device_id", deviceId);
    if (error) throw new Error(`devices updateClient failed: ${error.message}`);
  }
}
