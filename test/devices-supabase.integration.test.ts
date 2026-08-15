// Real-Supabase round trip for SupabaseDeviceRegistry. Runs only when the
// relay's server credentials are present (.env: SUPABASE_URL +
// SUPABASE_SECRET_KEY) — skips otherwise, so `npm test` stays green on a fresh
// clone. Cleans up its own rows (name prefix "itest-").

import { describe, it, expect, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "../src/supabase.js";
import { SupabaseDeviceRegistry } from "../src/devices-supabase.js";
import { parseDeviceToken, hmacDeviceSecret } from "../src/device-keys.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const enabled = !!(url && key);
const PEPPER = "itest-pepper";

const db = enabled ? createDb(url!, key!) : null;

afterAll(async () => {
  if (db) await db.from("devices").delete().like("name", "itest-%");
});

describe.skipIf(!enabled)("SupabaseDeviceRegistry (real db, HMAC keys)", () => {
  const reg = () => new SupabaseDeviceRegistry(db!, { now: Date.now, randomUUID, randomBytes, pepper: PEPPER });

  it("issues, verifies, revokes — HMAC-keyed, never storing the secret", async () => {
    const r = reg();
    const name = `itest-${Date.now()}`;
    const { deviceId, token } = await r.issue(name, "itest-user");
    const parsed = parseDeviceToken(token)!;

    const rec = await r.verify(token);
    expect(rec).toMatchObject({ deviceId, name, userId: "itest-user" });
    expect(await r.verify("bogus")).toBeNull();
    expect(await r.verify(`sk-device-${parsed.kid}.wrongsecret`)).toBeNull(); // right kid, wrong secret
    expect((await r.listByUser("itest-user")).some((d) => d.deviceId === deviceId)).toBe(true);
    expect(await r.findOwned(deviceId, "itest-user")).toMatchObject({ deviceId, userId: "itest-user" });
    expect(await r.findOwned(deviceId, "other-user")).toBeNull();

    // The db holds kid + an HMAC of user_id||secret — NOT the secret itself.
    const { data } = await db!.from("devices").select("kid, hmac").eq("device_id", deviceId).single();
    expect(data!.kid).toBe(parsed.kid);
    expect(data!.hmac).not.toBe(parsed.secret);
    expect(data!.hmac).toBe(hmacDeviceSecret("itest-user", parsed.secret, PEPPER));

    // Revoke tombstones: token dead, device gone from listByUser, row still there.
    expect(await r.revoke(deviceId)).toBe(true);
    expect(await r.verify(token)).toBeNull();
    expect((await r.listByUser("itest-user")).some((d) => d.deviceId === deviceId)).toBe(false);
    expect(await r.findOwned(deviceId, "itest-user")).toBeNull();
    expect(await r.revoke(deviceId)).toBe(false);
  });

  it("rejects a tampered token — B's kid replayed with A's secret", async () => {
    const r = reg();
    const a = await r.issue(`itest-${Date.now()}-A`, "user-A");
    const b = await r.issue(`itest-${Date.now()}-B`, "user-B");
    const pa = parseDeviceToken(a.token)!;
    const pb = parseDeviceToken(b.token)!;

    // Splice B's kid onto A's secret: verify recomputes HMAC with B's user_id +
    // A's secret, which can't match B's stored MAC. Cross-user replay dies.
    const tampered = `sk-device-${pb.kid}.${pa.secret}`;
    expect(await r.verify(tampered)).toBeNull();

    // Sanity: each token still verifies on its own.
    expect(await r.verify(a.token)).toMatchObject({ userId: "user-A" });
    expect(await r.verify(b.token)).toMatchObject({ userId: "user-B" });

    await r.revoke(a.deviceId);
    await r.revoke(b.deviceId);
  });

  it("stores and returns client metadata", async () => {
    const r = reg();
    const name = `itest-${Date.now()}-client`;
    const { deviceId, token } = await r.issue(name, "itest-user", "inst-meta", {
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(await r.verify(token)).toMatchObject({
      deviceId,
      name,
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
      installId: "inst-meta",
    });
    expect(await r.findOwned(deviceId, "itest-user")).toMatchObject({
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect((await r.listByUser("itest-user")).find((d) => d.deviceId === deviceId)).toMatchObject({
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    await r.updateClient(deviceId, { clientLabel: "Cursor", platform: "linux", osLabel: "Ubuntu 24.04" });
    expect(await r.verify(token)).toMatchObject({
      name,
      userId: "itest-user",
      clientLabel: "Cursor",
      platform: "linux",
      osLabel: "Ubuntu 24.04",
    });
    await r.revoke(deviceId);
  });
});
