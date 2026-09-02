/**
 * Waking a cloud environment that went to sleep underneath somebody.
 *
 * Wake-on-attach covers a person arriving at a sleeping machine. It does not
 * cover the other order, which is the one that actually happened: the reader
 * was already on the page, the machine paused because it had been idle for a
 * few minutes, its outbound socket died — and because no new attach ever
 * occurred, nothing woke it. The page truthfully reported that the environment
 * was not responding, and it would have gone on saying so.
 *
 * The gate is PRESENCE rather than an open socket. A tab left open overnight is
 * not a reason to keep a machine awake and billing; somebody who was
 * interacting a moment ago is.
 *
 * WAKE ON SEND is the other half, and it is here because it is the same
 * mechanism. Presence lapses while a person READS — reading is not
 * interacting — so the drop path declines to wake, and the next click lands
 * on a machine nobody is going to start. That is what the owner hit on
 * production: Clone did nothing, and a refresh fixed it only because
 * attaching was the sole on-demand wake trigger and clicking was not.
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
import { WakeCoordinator } from "../src/environment-waker";
import { PresenceTracker } from "../src/presence";

let handle: RelayServer | undefined;
let base = "";
let wsBase = "";
let devices: InMemoryDeviceRegistry;
let environments: InMemoryEnvironmentStore;
let presence: PresenceTracker;
let woke: string[] = [];

async function boot() {
  woke = [];
  const hub = new Hub();
  devices = new InMemoryDeviceRegistry({
    now: Date.now, randomUUID, randomBytes, randomId: () => randomUUID(),
  });
  environments = new InMemoryEnvironmentStore();
  presence = new PresenceTracker();
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8) }),
    devices,
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [] }) },
    hub,
    environments,
    presence,
    waker: new WakeCoordinator({
      // Takes a tick, because a provider call does. An instantly-resolving
      // fake gives the coordinator's in-flight map a one-microtask window and
      // makes its dedupe untestable — the push records that a CALL was made,
      // so joiners must not add one.
      wake: async (env) => {
        woke.push(env.externalId);
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true };
      },
    }),
    pingIntervalMs: 0,
    log: () => {},
  });
  await new Promise<void>((r, j) => {
    if (handle!.server.listening) return r();
    handle!.server.once("listening", () => r());
    handle!.server.once("error", j);
  });
  base = `http://127.0.0.1:${handle.port()}`;
  wsBase = `ws://127.0.0.1:${handle.port()}`;
}

/** A linked device with an environment behind it, and a live uplink. */
async function linkedCloudDevice() {
  const issued = await devices.issue("Cloud", MOCK_USER_ID, undefined, { platform: "cloud" });
  await environments.create({
    deviceId: issued.deviceId, userId: MOCK_USER_ID,
    provider: "sprite", externalId: `sprite-${issued.deviceId.slice(0, 6)}`,
  });
  const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(issued.token)}`);
  await new Promise<void>((r, j) => { uplink.once("open", () => r()); uplink.once("error", j); });
  return { ...issued, uplink };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("a machine that sleeps while somebody is there", () => {
  it("is woken when its uplink drops", async () => {
    const d = await linkedCloudDevice();
    // Somebody is present — the browser has said so recently.
    presence.touch(d.deviceId);

    d.uplink.close();
    await settle();

    expect(woke.length).toBe(1);
  });

  it("is NOT woken when nobody is there", async () => {
    // The whole cost model rests on this. An environment whose reader has gone
    // must be allowed to stay asleep, however its socket ended.
    const d = await linkedCloudDevice();
    d.uplink.close();
    await settle();

    expect(woke).toEqual([]);
  });

  it("is not woken when it is an ordinary machine", async () => {
    // A laptop that closed its lid is not something the relay can or should
    // start, and trying would be a provider call for a machine we do not run.
    const issued = await devices.issue("Laptop", MOCK_USER_ID, undefined, {});
    const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(issued.token)}`);
    await new Promise<void>((r, j) => { uplink.once("open", () => r()); uplink.once("error", j); });
    presence.touch(issued.deviceId);

    uplink.close();
    await settle();

    expect(woke).toEqual([]);
  });

  it("does not wake it again while a wake is already in flight", async () => {
    // A machine that drops, is woken, and drops again before it reconnects must
    // not stack provider calls.
    const d = await linkedCloudDevice();
    presence.touch(d.deviceId);
    d.uplink.close();
    await settle();
    const first = woke.length;

    // A second close on an already-closed socket must not re-fire.
    d.uplink.close();
    await settle();

    expect(woke.length).toBe(first);
  });
});

describe("a click that lands on a sleeping machine", () => {
  /** A browser attached to the device, past the wake-on-attach window. */
  async function attachedBrowser(deviceId: string) {
    const ws = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`);
    await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
    await settle();
    woke.length = 0; // forget the attach wake; this suite is about the send
    return ws;
  }

  it("wakes the machine, with NOBODY marked present", async () => {
    // The discriminating case. Presence is deliberately never touched, so the
    // drop path cannot be what fires — if a wake happens, the send caused it.
    const d = await linkedCloudDevice();
    const browser = await attachedBrowser(d.deviceId);
    d.uplink.close();
    await settle();
    expect(woke, "drop must not have woken it").toEqual([]);

    browser.send(JSON.stringify({ type: "removeProjectFolder", cwd: "/tmp/x" }));
    await settle();

    expect(woke.length).toBe(1);
    browser.close();
  });

  it("does not wake an ordinary machine", async () => {
    // A laptop that closed its lid is not something the relay can start.
    const issued = await devices.issue("Laptop", MOCK_USER_ID, undefined, {});
    const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(issued.token)}`);
    await new Promise<void>((r, j) => { uplink.once("open", () => r()); uplink.once("error", j); });
    const browser = await attachedBrowser(issued.deviceId);
    uplink.close();
    await settle();

    browser.send(JSON.stringify({ type: "removeProjectFolder", cwd: "/tmp/x" }));
    await settle();

    expect(woke).toEqual([]);
    browser.close();
  });

  it("does not stack a wake per frame while one is in flight", async () => {
    // An offline client can send several frames in a row. That must be one
    // provider call, not one per click.
    const d = await linkedCloudDevice();
    const browser = await attachedBrowser(d.deviceId);
    d.uplink.close();
    await settle();

    for (let i = 0; i < 5; i++) {
      browser.send(JSON.stringify({ type: "removeProjectFolder", cwd: `/tmp/x${i}` }));
    }
    await settle();

    expect(woke.length).toBe(1);
    browser.close();
  });

  it("does not wake while the uplink is healthy", async () => {
    // The control. A send that can be delivered is not evidence of anything
    // being asleep, and waking on it would bill for every message.
    const d = await linkedCloudDevice();
    const browser = await attachedBrowser(d.deviceId);

    browser.send(JSON.stringify({ type: "removeProjectFolder", cwd: "/tmp/x" }));
    await settle();

    expect(woke).toEqual([]);
    browser.close();
  });
});
