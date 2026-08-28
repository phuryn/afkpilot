/**
 * The cloud gate, on the socket a phone actually opens.
 *
 * `/api/cloud/open` has always checked it, and that is enough right up until
 * somebody keeps the URL. A cloud environment's deviceId is stable and the
 * /chat page takes it in the query string, so a person whose cloud plan lapsed
 * can skip the picker entirely and go straight back to the machine. Attaching
 * is also what WAKES it, so arriving at that saved link is itself what starts
 * the meter on hardware we pay for.
 *
 * `remote` and the cloud feature are deliberately different products: one gates
 * driving your own laptop from a phone, the other gates a machine that is ours.
 * These tests hold that line at the socket.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRelayServer, type RelayServer, CLOSE_ENTITLEMENT_REQUIRED } from "../src/server";
import { Hub } from "../src/hub";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices";
import { LinkStore } from "../src/link-store";
import { InMemoryEnvironmentStore } from "../src/environment-store";

let handle: RelayServer | undefined;
let wsBase = "";
let devices: InMemoryDeviceRegistry;
let environments: InMemoryEnvironmentStore;
let features: string[] = [];

async function boot() {
  const hub = new Hub();
  devices = new InMemoryDeviceRegistry({
    now: Date.now, randomUUID, randomBytes, randomId: () => randomUUID(),
  });
  environments = new InMemoryEnvironmentStore();
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8) }),
    devices,
    // Entitled for `remote` throughout, so nothing here can pass or fail for
    // the ordinary reason — only the cloud feature is in question.
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [...features, "remote"] }) },
    requiredFeature: "remote",
    cloudFeature: "cloud",
    hub,
    environments,
    pingIntervalMs: 0,
    log: () => {},
  });
  await new Promise<void>((r, j) => {
    if (handle!.server.listening) return r();
    handle!.server.once("listening", () => r());
    handle!.server.once("error", j);
  });
  wsBase = `ws://127.0.0.1:${handle.port()}`;
}

/** Resolves to the close code, or 0 if the socket opened and stayed open. */
function attach(deviceId: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`);
    ws.on("close", (code) => resolve(code));
    ws.on("open", () => setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { ws.close(); resolve(0); } }, 120));
    ws.on("error", () => { /* close follows */ });
  });
}

async function cloudDevice() {
  const issued = await devices.issue("Cloud", MOCK_USER_ID, undefined, { platform: "cloud" });
  await environments.create({
    deviceId: issued.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId: "s1",
  });
  return issued;
}

beforeEach(async () => { features = []; await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("attaching to a machine we pay for", () => {
  it("refuses a saved link when the cloud plan has lapsed", async () => {
    const d = await cloudDevice();
    expect(await attach(d.deviceId)).toBe(CLOSE_ENTITLEMENT_REQUIRED);
  });

  it("admits the same person once they have the feature", async () => {
    const d = await cloudDevice();
    features = ["cloud"];
    expect(await attach(d.deviceId)).toBe(0);
  });

  it("admits a wildcard grant", async () => {
    const d = await cloudDevice();
    features = ["*"];
    expect(await attach(d.deviceId)).toBe(0);
  });

  it("leaves an ordinary laptop alone", async () => {
    // The cloud feature gates a machine that is ours. Somebody's own computer
    // is none of its business, and gating it here would lock people out of
    // hardware they are already paying the electricity for.
    const laptop = await devices.issue("Laptop", MOCK_USER_ID, undefined, {});
    expect(await attach(laptop.deviceId)).toBe(0);
  });
});

describe("when the database will not answer", () => {
  it("refuses rather than admitting", async () => {
    // Fails closed, exactly as the device lookup beside it does. Falling
    // through looks kinder until you notice what the socket does next: it
    // WAKES the machine, with a second lookup that may well succeed. Two
    // lookups with two answers is how a lapsed plan gets in and starts the
    // meter — and the fallthrough bought nothing anyway, since the device
    // lookup reads the same database and would refuse regardless.
    const d = await cloudDevice();
    environments.find = async () => { throw new Error("supabase down"); };
    expect(await attach(d.deviceId)).toBe(1011);
  });
});
