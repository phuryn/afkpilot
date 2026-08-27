/**
 * Holding a cloud machine awake, through the real server.
 *
 * The coordinator's own suite covers when to hold and when to let go. This
 * covers the wiring, which is where the feature would actually fail: the
 * externalId is resolved once per uplink from the environment store, and if
 * that lookup is wrong or never runs, every hold silently doesn't happen. There
 * is no error to see — just machines that go to sleep mid-turn, which is
 * indistinguishable from the bug this was built to fix.
 *
 * The measurement underneath all of it (2026-08-27): a Sprite suspends about a
 * minute after its last interaction, and suspended is FROZEN — a service
 * writing every five seconds stopped dead the moment the machine went `warm`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRelayServer, type RelayServer } from "../src/server";
import { Hub } from "../src/hub";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices";
import { LinkStore } from "../src/link-store";
import { InMemoryEnvironmentStore } from "../src/environment-store";
import { KeepAliveCoordinator } from "../src/environment-keepalive";

let handle: RelayServer | undefined;
let wsBase = "";
let devices: InMemoryDeviceRegistry;
let environments: InMemoryEnvironmentStore;
let keepAlive: KeepAliveCoordinator;
let holds: string[] = [];
let releases: string[] = [];

async function boot() {
  holds = [];
  releases = [];
  const hub = new Hub();
  devices = new InMemoryDeviceRegistry({
    now: Date.now, randomUUID, randomBytes, randomId: () => randomUUID(),
  });
  environments = new InMemoryEnvironmentStore();
  keepAlive = new KeepAliveCoordinator({
    hold: (externalId) => {
      holds.push(externalId);
      return { release: () => { releases.push(externalId); } };
    },
    now: Date.now,
  });
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8) }),
    devices,
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [] }) },
    hub,
    environments,
    keepAlive,
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

const settle = () => new Promise((r) => setTimeout(r, 150));

async function openUplink(token: string) {
  const ws = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(token)}`);
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.send(JSON.stringify({ t: "hello", proto: 1 }));
  // The environment lookup that resolves the hold target is async and started
  // at admit time; the first frame must not race it.
  await settle();
  return ws;
}

/** A cloud device with an environment behind it. */
async function cloudDevice(externalId = "sprite-1") {
  const issued = await devices.issue("Cloud", MOCK_USER_ID, undefined, { platform: "cloud" });
  await environments.create({
    deviceId: issued.deviceId, userId: MOCK_USER_ID, provider: "sprite", externalId,
  });
  return issued;
}

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("what starts a hold", () => {
  it("holds the machine a working frame came from", async () => {
    // The `working` frame is the honest signal: a turn that spends four minutes
    // in a test run streams nothing, so relying on chat output would hold the
    // machine awake for exactly the part of a turn that never needed it.
    const d = await cloudDevice("sprite-abc");
    const ws = await openUplink(d.token);
    ws.send(JSON.stringify({ t: "working" }));
    await settle();
    expect(holds).toEqual(["sprite-abc"]);
    expect(keepAlive.holding(d.deviceId)).toBe(true);
    ws.close();
  });

  it("holds on ordinary streamed output too", async () => {
    // Old extensions do not send `working` and must still be protected —
    // arrival is the signal, not the frame's type.
    const d = await cloudDevice("sprite-old");
    const ws = await openUplink(d.token);
    ws.send(JSON.stringify({ t: "host", msg: { type: "assistantDelta", text: "hi" } }));
    await settle();
    expect(holds).toEqual(["sprite-old"]);
    ws.close();
  });

  it("holds once across a whole turn's worth of frames", async () => {
    const d = await cloudDevice("sprite-many");
    const ws = await openUplink(d.token);
    for (let i = 0; i < 50; i += 1) ws.send(JSON.stringify({ t: "working" }));
    await settle();
    expect(holds).toEqual(["sprite-many"]);
    ws.close();
  });

  it("holds nothing for an ordinary laptop", async () => {
    // A machine we do not run is not ours to keep awake, and there is nothing
    // to open a session against.
    const issued = await devices.issue("Laptop", MOCK_USER_ID, undefined, {});
    const ws = await openUplink(issued.token);
    ws.send(JSON.stringify({ t: "working" }));
    await settle();
    expect(holds).toEqual([]);
    expect(keepAlive.size()).toBe(0);
    ws.close();
  });
});

describe("what ends one", () => {
  it("releases when the uplink goes", async () => {
    // Every hold is a machine being billed. A host that disconnected is not
    // working, whatever its idle clock says.
    const d = await cloudDevice("sprite-gone");
    const ws = await openUplink(d.token);
    ws.send(JSON.stringify({ t: "working" }));
    await settle();
    expect(holds).toEqual(["sprite-gone"]);
    ws.close();
    await settle();
    expect(releases).toEqual(["sprite-gone"]);
    expect(keepAlive.size()).toBe(0);
  });

  it("re-holds when the machine comes back", async () => {
    // Reconnects are ordinary — a sleeping machine that is woken reconnects.
    const d = await cloudDevice("sprite-again");
    const first = await openUplink(d.token);
    first.send(JSON.stringify({ t: "working" }));
    await settle();
    first.close();
    await settle();
    const second = await openUplink(d.token);
    second.send(JSON.stringify({ t: "working" }));
    await settle();
    expect(holds).toEqual(["sprite-again", "sprite-again"]);
    expect(releases).toEqual(["sprite-again"]);
    second.close();
  });
});
