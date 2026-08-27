/**
 * Cloud environments through the real server.
 *
 * The unit suites cover the decisions; this covers the wiring, which is where a
 * feature like this actually breaks — an endpoint that authenticates the wrong
 * principal, an availability field computed from the wrong device, a relay
 * configured WITHOUT environments suddenly behaving differently for everyone.
 *
 * That last one is why several of these assert that nothing changed.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { createRelayServer, type RelayServer } from "../src/server";
import { Hub } from "../src/hub";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices";
import { LinkStore } from "../src/link-store";
import { InMemoryEnvironmentStore } from "../src/environment-store";
import { WakeCoordinator, type WakeOutcome } from "../src/environment-waker";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";

let handle: RelayServer | undefined;
let base = "";

interface Harness {
  devices: InMemoryDeviceRegistry;
  environments: InMemoryEnvironmentStore;
  hub: Hub;
  wakes: string[];
  outcome: () => WakeOutcome;
}

let h: Harness;

async function boot(opts: { withEnvironments?: boolean } = {}) {
  const hub = new Hub();
  const devices = new InMemoryDeviceRegistry({
    now: () => 1_700_000_000_000,
    randomUUID,
    randomBytes,
    randomId: () => randomUUID(),
  });
  const environments = new InMemoryEnvironmentStore(() => 1_700_000_000_000);
  const wakes: string[] = [];
  let outcome: WakeOutcome = { ok: true };
  const waker = new WakeCoordinator({
    wake: async (e) => { wakes.push(e.deviceId); return outcome; },
  });
  h = { devices, environments, hub, wakes, outcome: () => outcome };
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8).toUpperCase() }),
    devices,
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [] }) },
    requiredFeature: undefined,
    hub,
    pingIntervalMs: 0,
    log: () => {},
    ...(opts.withEnvironments === false ? {} : { environments, waker }),
  });
  // createRelayServer calls listen() and returns immediately, so the ephemeral
  // port is not assigned yet. Waiting for the listening event is the difference
  // between a suite and ten "fetch failed".
  await new Promise<void>((resolve, reject) => {
    if (handle!.server.listening) return resolve();
    handle!.server.once("listening", () => resolve());
    handle!.server.once("error", reject);
  });
  base = `http://127.0.0.1:${handle.port()}`;
  return { setOutcome: (o: WakeOutcome) => { outcome = o; } };
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const devicesJson = async () => (await (await fetch(`${base}/api/devices`)).json()) as {
  devices: { deviceId: string; availability: string; environment: unknown; online: boolean }[];
};

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

async function makeDevice(name = "Cloud — test") {
  return h.devices.issue(name, MOCK_USER_ID, undefined, {});
}

describe("what the picker is told", () => {
  it("reports an offline ordinary machine as offline", async () => {
    await makeDevice("Laptop");
    const { devices } = await devicesJson();
    expect(devices[0].availability).toBe("offline");
    expect(devices[0].environment).toBeNull();
  });

  it("reports an offline ENVIRONMENT as ready, because it can be woken", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const { devices } = await devicesJson();
    expect(devices[0].online).toBe(false);
    expect(devices[0].availability).toBe("ready");
    expect(devices[0].environment).toEqual({ provider: "sprite" });
  });

  it("never puts the provider's identity on the wire", async () => {
    // The sprite's name is ours, not the reader's — and a name is enough to
    // address it.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "secret-sprite-name",
    });
    const raw = await (await fetch(`${base}/api/devices`)).text();
    expect(raw).not.toContain("secret-sprite-name");
  });

  it("keeps `online` meaning exactly what it always meant", async () => {
    // Anything already reading `online` must not change behaviour.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    expect((await devicesJson()).devices[0].online).toBe(false);
  });
});

describe("scheduling a wake", () => {
  it("accepts a timestamp from the device itself", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const when = Date.now() + 3_600_000;
    const res = await post("/api/environment/wake-at", { wakeAt: when }, d.token);
    expect(res.status).toBe(200);
    expect((await h.environments.find(d.deviceId))?.wakeAt).toBe(when);
  });

  it("accepts null, so a host with no routines can clear a stale wake", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    await post("/api/environment/wake-at", { wakeAt: Date.now() + 60_000 }, d.token);
    expect((await post("/api/environment/wake-at", { wakeAt: null }, d.token)).status).toBe(200);
    expect((await h.environments.find(d.deviceId))?.wakeAt).toBeNull();
  });

  it("refuses without a device token — a browser session is not a machine", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    // No Authorization at all. The mock verifier would happily accept any
    // SESSION, which is exactly the confusion this endpoint must not make.
    expect((await post("/api/environment/wake-at", { wakeAt: Date.now() + 60_000 })).status).toBe(401);
  });

  it("refuses a device that is not an environment", async () => {
    const d = await makeDevice("Laptop");
    const res = await post("/api/environment/wake-at", { wakeAt: Date.now() + 60_000 }, d.token);
    expect(res.status).toBe(404);
  });

  it("refuses rubbish rather than coercing it", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    for (const wakeAt of ["soon", Date.now() - 3_600_000, {}]) {
      expect((await post("/api/environment/wake-at", { wakeAt }, d.token)).status).toBe(400);
    }
    expect((await h.environments.find(d.deviceId))?.wakeAt).toBeNull();
  });
});

describe("a relay with no environments configured", () => {
  it("serves devices exactly as before and refuses the endpoint", async () => {
    await handle?.close();
    await boot({ withEnvironments: false });
    const d = await makeDevice("Laptop");
    const { devices } = await devicesJson();
    expect(devices[0].availability).toBe("offline");
    expect(devices[0].environment).toBeNull();
    const res = await post("/api/environment/wake-at", { wakeAt: Date.now() + 60_000 }, d.token);
    expect(res.status).toBe(404);
  });
});
