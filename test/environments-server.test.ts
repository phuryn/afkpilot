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
  devices: { deviceId: string | null; availability: string; environment: unknown; online: boolean }[];
};

/** The row for a real device. Indexing by 0 stopped working when every account
 *  gained a synthetic cloud row at the top — and a test that asserts on
 *  whichever row happens to be first is asserting on the wrong thing anyway. */
const rowFor = async (deviceId: string) =>
  (await devicesJson()).devices.find((d) => d.deviceId === deviceId)!;

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

async function makeDevice(name = "Cloud — test") {
  return h.devices.issue(name, MOCK_USER_ID, undefined, {});
}

describe("what the picker is told", () => {
  it("reports an offline ordinary machine as offline", async () => {
    const d = await makeDevice("Laptop");
    const row = await rowFor(d.deviceId);
    expect(row.availability).toBe("offline");
    expect(row.environment).toBeNull();
  });

  it("reports an offline ENVIRONMENT as ready, because it can be woken", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    // It has linked before — which is what makes "offline" mean asleep here,
    // rather than still being built. A machine that has NEVER linked is a
    // different row with a different word on it; see the build tests below.
    await h.environments.markReady(d.deviceId, 1_000);
    const row = await rowFor(d.deviceId);
    expect(row.online).toBe(false);
    expect(row.availability).toBe("ready");
    expect(row.environment).toEqual({ provider: "sprite", state: "ready", buildingForMs: null });
  });

  it("reports a machine that has never linked as being built, not as offline", async () => {
    // The twenty-five-minute case. Saying "offline" to somebody who has just
    // asked for a machine to be MADE reads as broken, and they would be right
    // to think so — nothing was going to change by waiting for a wake that has
    // nothing to wake.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const row = await rowFor(d.deviceId);
    expect(row.availability).toBe("building");
    expect(row.environment.state).toBe("building");
    expect(row.environment.buildingForMs).toBeGreaterThanOrEqual(0);
  });

  it("shows only ONE cloud row while a machine is being built", async () => {
    // The synthetic row and the real device row are both cloud rows. Before the
    // build state existed the synthetic one stepped aside only once a machine
    // WORKED, so a build painted the picker twice.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const rows = (await devicesJson()).devices;
    // Counted the way the picker counts them: a row is a cloud row if it
    // carries an environment, or if it is the synthetic one that stands in
    // before any machine exists.
    const cloudRows = rows.filter((r) => r.environment !== null || r.platform === "cloud");
    expect(cloudRows.length).toBe(1);
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
    expect((await rowFor(d.deviceId)).online).toBe(false);
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
    const row = await rowFor(d.deviceId);
    expect(row.availability).toBe("offline");
    expect(row.environment).toBeNull();
    const res = await post("/api/environment/wake-at", { wakeAt: Date.now() + 60_000 }, d.token);
    expect(res.status).toBe(404);
  });
});

describe("a cloud environment cannot be removed out from under its machine", () => {
  // The picker offers Reset and no Remove, and /api/cloud/reset explains why:
  // the row never goes away, only the machine behind it does. The API has to
  // say the same thing. Revoking a cloud device's row without destroying the
  // sprite leaves a machine that is still running and still billing with
  // nothing pointing at it — no row, no name in any list, and no way for its
  // owner or for us to find it again.
  const del = (deviceId: string) =>
    fetch(`${base}/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });

  it("refuses DELETE for a device that has one", async () => {
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const res = await del(d.deviceId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "cloud-environment" });
    // Still there, still theirs.
    expect(await rowFor(d.deviceId)).toBeTruthy();
  });

  it("refuses the device-token unlink too", async () => {
    // The extension calls this on local sign-out. A cloud machine's identity
    // was handed TO it by the relay and is not the host's to give up.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    const res = await post("/api/device/unlink", {}, d.token);
    expect(res.status).toBe(409);
    expect(await rowFor(d.deviceId)).toBeTruthy();
  });

  it("refuses rather than guesses when the database is down", async () => {
    // The failure this whole guard exists to prevent, arriving through the
    // guard: "there is no environment" is exactly what a database blip says,
    // and revoking is irreversible. So the lookup fails CLOSED — a removal that
    // waits is recoverable; one that strands a billing machine is not.
    const d = await makeDevice();
    await h.environments.create({
      deviceId: d.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
    });
    h.environments.find = async () => { throw new Error("supabase down"); };
    expect((await del(d.deviceId)).status).toBe(503);
    expect(await rowFor(d.deviceId)).toBeTruthy();
  });

  it("still removes an ordinary laptop", async () => {
    // The guard must not cost everybody else the operation they do have.
    const d = await makeDevice("Laptop");
    expect((await del(d.deviceId)).status).toBe(200);
    expect(await rowFor(d.deviceId)).toBeUndefined();
  });
});
