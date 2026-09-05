/**
 * Lazy provisioning, entitlement, and reset — through the real server.
 *
 * Three of these exist because the mistake they describe costs money or gives
 * something away:
 *
 *  - two tabs opening a first-time cloud row must make ONE sprite;
 *  - a host must not be able to mint unlimited free devices by CLAIMING to be
 *    a cloud environment;
 *  - reset must destroy the machine before it forgets about it, or the bill has
 *    no owner.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRelayServer, type RelayServer } from "../src/server";
import { Hub } from "../src/hub";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices";
import { LinkStore } from "../src/link-store";
import { InMemoryEnvironmentStore, SupabaseEnvironmentStore } from "../src/environment-store";
import { supabaseResult } from "./helpers/supabase-result";
import { HandoverCodes } from "../src/environment-handover";
import { WakeCoordinator } from "../src/environment-waker";
import { ProvisionCoordinator, spriteNameFor } from "../src/environment-provisioner";
import { InMemoryUsageStore } from "../src/usage";
import { MinuteRateLimiter } from "../src/limits";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";

let handle: RelayServer | undefined;
let base = "";
let created: string[] = [];
let destroyed: string[] = [];
let environments: InMemoryEnvironmentStore;
let devices: InMemoryDeviceRegistry;
let features: string[] = [];

async function boot(opts: { cloudFeature?: string; provisionFails?: "quota" | "unavailable"; freeDevices?: number } = {}) {
  created = [];
  destroyed = [];
  features = [];
  const hub = new Hub();
  devices = new InMemoryDeviceRegistry({
    now: () => 1_700_000_000_000, randomUUID, randomBytes, randomId: () => randomUUID(),
  });
  environments = new InMemoryEnvironmentStore(() => 1_700_000_000_000);
  const provisioner = new ProvisionCoordinator({
    create: async (userId) => {
      if (opts.provisionFails) return { ok: false, kind: opts.provisionFails };
      const name = spriteNameFor(userId);
      created.push(name);
      return { ok: true, externalId: name };
    },
    destroy: async (id) => { destroyed.push(id); return true; },
    exec: async () => ({ ok: true, exitCode: 0, output: "" }),
  });
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8).toUpperCase() }),
    devices,
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features }) },
    requiredFeature: opts.freeDevices === undefined ? undefined : "remote",
    freeTier: opts.freeDevices === undefined
      ? undefined
      : { devices: opts.freeDevices, weeklyMsgs: 100, usage: new InMemoryUsageStore() },
    messageRate: { perMinute: 100, limiter: new MinuteRateLimiter(Date.now) },
    hub,
    environments,
    waker: new WakeCoordinator({ wake: async () => ({ ok: true }) }),
    provisioner,
    publicUrl: "https://relay.example",
    handover: new HandoverCodes(Date.now, randomUUID),
    cloudFeature: opts.cloudFeature,
    pingIntervalMs: 0,
    log: () => {},
  });
  await new Promise<void>((resolve, reject) => {
    if (handle!.server.listening) return resolve();
    handle!.server.once("listening", () => resolve());
    handle!.server.once("error", reject);
  });
  base = `http://127.0.0.1:${handle.port()}`;
}

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const list = async () => (await (await fetch(`${base}/api/devices`)).json()) as {
  devices: { deviceId: string | null; platform: string; availability: string; environment: { state?: string } | null }[];
};

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("unavailable inventory and reset bookkeeping", () => {
  it.each(["open", "reset"])("C6/C8: %s refuses a returned read error and rechecks on retry", async operation => {
    const first = await (await post("/api/cloud/open")).json() as { deviceId: string };
    const original = environments.listByUser.bind(environments);
    const sql = new SupabaseEnvironmentStore(supabaseResult(() => ({ data: null, error: { message: "read failed" } })));
    environments.listByUser = sql.listByUser.bind(sql);
    const res = await post(`/api/cloud/${operation}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual([]);
    expect(await original(MOCK_USER_ID)).toHaveLength(1);
    environments.listByUser = original;
    const retry = await post(`/api/cloud/${operation}`);
    expect(retry.status).toBe(200);
    if (operation === "open") expect((await retry.json() as { deviceId: string }).deviceId).toBe(first.deviceId);
    else expect(await environments.find(first.deviceId)).toBeNull();
  });

  it.each(["false", "throw"])("C8: reset reports failed removal (%s), and a second reset completes", async failure => {
    const first = await (await post("/api/cloud/open")).json() as { deviceId: string };
    const remove = environments.remove.bind(environments);
    environments.remove = async () => {
      if (failure === "throw") throw new Error("write failed");
      return false;
    };
    const res = await post("/api/cloud/reset");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
    expect(destroyed).toHaveLength(1);
    expect(await environments.find(first.deviceId)).not.toBeNull();
    environments.remove = remove;
    const retry = await post("/api/cloud/reset");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, reset: true });
    expect(destroyed).toHaveLength(2); // provider's already-gone result is success
    expect(await environments.find(first.deviceId)).toBeNull();
    expect(await devices.findOwned(first.deviceId, MOCK_USER_ID)).toBeNull();
    const reopened = await (await post("/api/cloud/open")).json() as { deviceId: string };
    expect(reopened.deviceId).not.toBe(first.deviceId);
    expect(await devices.findOwned(reopened.deviceId, MOCK_USER_ID)).not.toBeNull();
  });

  it.each(["false", "throw"])("keeps the reset record when revocation fails (%s)", async failure => {
    const first = await (await post("/api/cloud/open")).json() as { deviceId: string };
    const revoke = devices.revoke.bind(devices);
    devices.revoke = async () => {
      if (failure === "throw") throw new Error("write failed");
      return false;
    };
    expect((await post("/api/cloud/reset")).status).toBe(503);
    expect(await environments.find(first.deviceId)).not.toBeNull();
    devices.revoke = revoke;
    expect((await post("/api/cloud/reset")).status).toBe(200);
    expect(await environments.find(first.deviceId)).toBeNull();
  });
});

describe("everyone gets a cloud row", () => {
  it("shows one before any sprite exists", async () => {
    // A machine that only appears once you have paid is a product nobody
    // discovers. The row is real; the machine is not, until somebody opens it.
    const { devices: rows } = await list();
    expect(rows[0].platform).toBe("cloud");
    expect(rows[0].deviceId).toBeNull();
    expect(rows[0].environment?.state).toBe("not-provisioned");
  });

  it("puts it first", async () => {
    await devices.issue("Laptop", MOCK_USER_ID, undefined, {});
    const { devices: rows } = await list();
    expect(rows[0].platform).toBe("cloud");
  });

  it("shows an upgrade, not an absence, when the plan does not include it", async () => {
    await handle?.close();
    await boot({ cloudFeature: "cloud" });
    const { devices: rows } = await list();
    expect(rows[0].environment?.state).toBe("upgrade");
    expect(rows[0].availability).toBe("upgrade");
  });
});

describe("opening it the first time", () => {
  it("provisions lazily and returns something to open", async () => {
    const res = await post("/api/cloud/open");
    const body = await res.json() as { ok: boolean; deviceId: string; provisioned: boolean };
    expect(res.status).toBe(200);
    expect(body.provisioned).toBe(true);
    expect(created).toEqual([spriteNameFor(MOCK_USER_ID)]);
    expect((await environments.find(body.deviceId))?.externalId).toBe(spriteNameFor(MOCK_USER_ID));
  });

  it("makes ONE sprite when two tabs open it at once", async () => {
    // The expensive race. Two first-opens must not become two machines.
    await Promise.all([post("/api/cloud/open"), post("/api/cloud/open")]);
    expect(created.length).toBe(1);
  });

  it("returns the same environment on later opens", async () => {
    const first = await (await post("/api/cloud/open")).json() as { deviceId: string };
    const second = await (await post("/api/cloud/open")).json() as { deviceId: string; provisioned?: boolean };
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.provisioned).toBeUndefined();
    expect(created.length).toBe(1);
  });

  it("never puts the device token on the wire", async () => {
    // It goes to the MACHINE as a secret. A browser has no use for it and every
    // reason not to hold it.
    const raw = await (await post("/api/cloud/open")).text();
    expect(raw).not.toMatch(/sk-device-/);
  });

  it("refuses with a nameable reason when the plan does not include it", async () => {
    await handle?.close();
    await boot({ cloudFeature: "cloud" });
    const res = await post("/api/cloud/open");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "upgrade" });
    expect(created).toEqual([]);
  });

  it("allows it when the account carries the feature", async () => {
    await handle?.close();
    await boot({ cloudFeature: "cloud" });
    features = ["cloud"];
    expect((await post("/api/cloud/open")).status).toBe(200);
  });

  it("passes a provider limit through as a limit, not a crash", async () => {
    await handle?.close();
    await boot({ provisionFails: "quota" });
    expect((await post("/api/cloud/open")).status).toBe(429);
  });
});

describe("the device limit", () => {
  it("does not count a cloud environment against a free user's laptop", async () => {
    // The offer must not take something away. A free user with one device
    // allowance keeps it.
    await handle?.close();
    await boot({ freeDevices: 1 });
    await post("/api/cloud/open");

    const started = await (await post("/api/link/start", { name: "Laptop" })).json() as { code: string };
    const approved = await post("/api/link/approve", { code: started.code });
    expect(approved.status).toBe(200);
  });

  it("cannot be dodged by a host CLAIMING to be a cloud environment", async () => {
    // `platform` is self-reported at link time. If the exclusion keyed on it, a
    // client could mint unlimited free devices by saying "cloud". The relay
    // keys on the environments table, which only it writes.
    await handle?.close();
    await boot({ freeDevices: 1 });
    const first = await (await post("/api/link/start", { name: "One", platform: "cloud" })).json() as { code: string };
    expect((await post("/api/link/approve", { code: first.code })).status).toBe(200);

    const second = await (await post("/api/link/start", { name: "Two", platform: "cloud" })).json() as { code: string };
    const res = await post("/api/link/approve", { code: second.code });
    expect(res.status).toBe(403);
    expect((await res.json() as { reason?: string }).reason).toBe("device-limit");
  });
});

describe("resetting it", () => {
  it("destroys the machine and forgets it, in that order", async () => {
    const { deviceId } = await (await post("/api/cloud/open")).json() as { deviceId: string };
    const res = await post("/api/cloud/reset");
    expect(res.status).toBe(200);
    expect(destroyed).toEqual([spriteNameFor(MOCK_USER_ID)]);
    expect(await environments.find(deviceId)).toBeNull();
  });

  it("leaves the row in place, because everyone has one", async () => {
    await post("/api/cloud/open");
    await post("/api/cloud/reset");
    const { devices: rows } = await list();
    expect(rows[0].platform).toBe("cloud");
    expect(rows[0].environment?.state).toBe("not-provisioned");
  });

  it("re-provisions on the next open, down the same path as a new user", async () => {
    await post("/api/cloud/open");
    await post("/api/cloud/reset");
    await post("/api/cloud/open");
    expect(created.length).toBe(2);
  });

  it("treats nothing-to-reset as success", async () => {
    // The end state the caller asked for is the end state they have.
    const res = await post("/api/cloud/reset");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reset: false });
  });

  it("keeps the record when the machine could not be destroyed", async () => {
    // Forgetting first would leave a sprite nobody has a record of — a bill
    // with no owner.
    await post("/api/cloud/open");
    await handle!.close();
    // Rebuild with a destroy that fails, keeping the same store.
    const failing = new ProvisionCoordinator({
      create: async () => ({ ok: false, kind: "unavailable" }),
      destroy: async () => false,
    });
    handle = createRelayServer({
      host: "127.0.0.1", port: 0, webRoot: join(process.cwd(), "web"),
      store: new LinkStore({ now: Date.now, randomCode: () => randomUUID() }),
      devices,
      sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [] }) },
      requiredFeature: undefined, hub: new Hub(), environments,
      waker: new WakeCoordinator({ wake: async () => ({ ok: true }) }),
      provisioner: failing, pingIntervalMs: 0, log: () => {},
    });
    await new Promise<void>((r) => { handle!.server.once("listening", () => r()); });
    base = `http://127.0.0.1:${handle.port()}`;
    expect((await post("/api/cloud/reset")).status).toBe(503);
    expect((await environments.listByUser(MOCK_USER_ID)).length).toBe(1);
  });
});
