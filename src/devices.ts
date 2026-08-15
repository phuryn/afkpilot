// Device registry — the auth/persistence seam. A "device" is one linked
// VS Code workspace (the extension's uplink); tokens are opaque random strings.
//
// server.ts codes against the async DeviceRegistry interface; main.ts picks the
// implementation: in-memory (mock auth, dev) or Supabase-persisted
// (devices-supabase.ts — production, devices scoped to a user id: Clerk's,
// once real logins land).

import { issueDeviceKey } from "./device-keys.js";
import type { DeviceClientInfo, DevicePlatform } from "./device-client.js";

export type { DeviceClientInfo, DevicePlatform };

export interface DeviceRecord {
  deviceId: string;
  /** Owning account (Clerk user id). MOCK_USER_ID until real auth lands. */
  userId: string;
  name: string;
  createdAt: number;
  /** Anonymous per-install GUID from the extension, when it sent one. Identifies
   *  the MACHINE so a re-link supersedes its old row instead of adding a second
   *  one (name is only a hostname label — one account holds five rows sharing a
   *  name). Undefined for devices linked before this existed. */
  installId?: string;
  /** Which host linked (e.g. "VS Code extension"). Absent on older rows. */
  clientLabel?: string;
  /** win | mac | linux | unknown. Absent on older rows. */
  platform?: DevicePlatform;
  /** Human OS label (e.g. "Windows 11"). Absent on older rows. */
  osLabel?: string;
}

export interface DeviceRegistry {
  issue(
    name: string,
    userId: string,
    installId?: string,
    client?: DeviceClientInfo,
  ): Promise<{ deviceId: string; token: string }>;
  verify(token: string): Promise<DeviceRecord | null>;
  revoke(deviceId: string): Promise<boolean>;
  /** Live (unrevoked) devices for one user. Server-side filtered — never fetch-all. */
  listByUser(userId: string): Promise<DeviceRecord[]>;
  /** Live device owned by this user, or null. Server-side filtered — never fetch-all. */
  findOwned(deviceId: string, userId: string): Promise<DeviceRecord | null>;
  /** Backfill/refresh client metadata only — never name or user_id. */
  updateClient(deviceId: string, client: DeviceClientInfo): Promise<void>;
}

/** Until Clerk lands, every device belongs to this pseudo-user. */
export const MOCK_USER_ID = "mock";

export interface InMemoryDeviceRegistryDeps {
  now: () => number;
  /** Injected crypto so tokens match the real `sk-device-<kid>.<secret>` shape. */
  randomUUID: () => string;
  randomBytes: (size: number) => Buffer;
  randomId: () => string;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  // Dev realism doesn't need HMAC — a plain token->record map is enough — but the
  // token still carries the production sk-device- format so clients see the same thing.
  private byToken = new Map<string, DeviceRecord>();

  constructor(private readonly deps: InMemoryDeviceRegistryDeps) {}

  async issue(
    name: string,
    userId: string,
    installId?: string,
    client?: DeviceClientInfo,
  ): Promise<{ deviceId: string; token: string }> {
    const { token } = issueDeviceKey({ randomUUID: this.deps.randomUUID, randomBytes: this.deps.randomBytes });
    const deviceId = this.deps.randomId();
    const rec: DeviceRecord = { deviceId, userId, name, createdAt: this.deps.now(), installId };
    if (client?.clientLabel) rec.clientLabel = client.clientLabel;
    if (client?.platform) rec.platform = client.platform;
    if (client?.osLabel) rec.osLabel = client.osLabel;
    this.byToken.set(token, rec);
    return { deviceId, token };
  }

  async verify(token: string): Promise<DeviceRecord | null> {
    return this.byToken.get(token) ?? null;
  }

  async revoke(deviceId: string): Promise<boolean> {
    for (const [token, rec] of this.byToken) {
      if (rec.deviceId === deviceId) {
        this.byToken.delete(token);
        return true;
      }
    }
    return false;
  }

  async listByUser(userId: string): Promise<DeviceRecord[]> {
    return [...this.byToken.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async findOwned(deviceId: string, userId: string): Promise<DeviceRecord | null> {
    return [...this.byToken.values()].find((d) => d.deviceId === deviceId && d.userId === userId) ?? null;
  }

  async updateClient(deviceId: string, client: DeviceClientInfo): Promise<void> {
    const rec = [...this.byToken.values()].find((d) => d.deviceId === deviceId);
    if (!rec) return;
    if (client.clientLabel !== undefined) rec.clientLabel = client.clientLabel;
    if (client.platform !== undefined) rec.platform = client.platform;
    if (client.osLabel !== undefined) rec.osLabel = client.osLabel;
  }
}
