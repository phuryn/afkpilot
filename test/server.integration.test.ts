// End-to-end over real HTTP + real WebSockets: the full device-link flow, then
// an extension-sim uplink and a browser-sim client exchanging protocol messages
// through the relay — the same choreography the VS Code extension and chat.js
// run in production (mock auth).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LinkStore, makeLinkCode } from "../src/link-store.js";
import { InMemoryDeviceRegistry, type DeviceRegistry } from "../src/devices.js";
import { MinuteRateLimiter } from "../src/limits.js";
import { InMemoryUsageStore, type UsageStore } from "../src/usage.js";
import { MockSessionVerifier, type SessionClaims, type SessionVerifier } from "../src/auth.js";
import { Hub } from "../src/hub.js";
import {
  createRelayServer,
  CLOSE_BAD_TOKEN,
  CLOSE_AUTH_REQUIRED,
  CLOSE_ENTITLEMENT_REQUIRED,
  CLOSE_PROTOCOL_ERROR,
  MAX_AUTH_PENDING_BYTES,
  MAX_AUTH_PENDING_FRAMES,
  MAX_WS_PAYLOAD_BYTES,
  type RelayServer,
} from "../src/server.js";
import { REMOTE_PROTO_VERSION } from "../src/frames.js";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

let relay: RelayServer;
let base: string;
let wsBase: string;

function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

/** Queueing inbox: a permanent listener buffers every frame, so two messages
 *  emitted back-to-back in one I/O callback can't slip past a `once` handler
 *  that isn't re-attached yet. */
class WsInbox {
  private queue: any[] = [];
  private waiter?: (m: any) => void;
  constructor(ws: WebSocket) {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(m);
      } else {
        this.queue.push(m);
      }
    });
  }
  next(timeoutMs = 5000): Promise<any> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error("timed out waiting for ws message"));
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }
  /** Consume until the predicate matches (skips e.g. clients-count frames). */
  async matching(pred: (m: any) => boolean): Promise<any> {
    for (let i = 0; i < 10; i++) {
      const m = await this.next();
      if (pred(m)) return m;
    }
    throw new Error("no matching message in 10");
  }
}

beforeAll(async () => {
  let n = 0;
  const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
  const devices = new InMemoryDeviceRegistry({
    now: Date.now,
    randomUUID: () => `kid-${++n}`,
    randomBytes: (size) => cryptoRandomBytes(size),
    randomId: () => `dev-${++n}`,
  });
  const hub = new Hub();
  // Permissive mock verifier + open entitlement gate: the existing e2e behaviour
  // is unchanged (the web pages don't send session tokens yet).
  relay = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot,
    store,
    devices,
    sessions: new MockSessionVerifier(true),
    requiredFeature: undefined,
    hub,
    log: () => {},
  });
  await new Promise<void>((r) => relay.server.once("listening", () => r()));
  base = `http://127.0.0.1:${relay.port()}`;
  wsBase = `ws://127.0.0.1:${relay.port()}`;
});

afterAll(async () => {
  await relay.close();
});

describe("relay end-to-end", () => {
  it("runs the whole story: link, uplink, browser snapshot, both directions, offline", async () => {
    // ---- device-link flow (what "Grok: Link Remote Device" does) ----
    const { json: started } = await post("/api/link/start", { name: "Test box — repo" });
    expect(started.code).toMatch(/^[A-Z2-9]{8}$/);
    const infoRes = await fetch(`${base}/api/link/info?code=${started.code}`);
    expect(await infoRes.json()).toEqual({ status: "pending", deviceName: "Test box — repo" });
    expect((await post("/api/link/poll", { code: started.code })).json).toEqual({ status: "pending" });
    expect((await post("/api/link/approve", { code: started.code })).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const polled = (await post("/api/link/poll", { code: started.code })).json;
    expect(polled.status).toBe("approved");
    const token: string = polled.token;
    expect(token).toBeTruthy();

    // ---- extension-sim uplink connects with the token ----
    const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(token)}`);
    const uplinkInbox = new WsInbox(uplink);
    await waitOpen(uplink);
    uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "Test box — repo" } }));

    // device now listed for the picker page
    const devicesList = (await (await fetch(`${base}/api/devices`)).json()).devices;
    expect(devicesList).toHaveLength(1);
    expect(devicesList[0].name).toBe("Test box — repo");
    const deviceId: string = devicesList[0].deviceId;

    // ---- browser-sim client joins, ready -> snapshot round trip ----
    const browser = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`);
    const browserInbox = new WsInbox(browser);
    await waitOpen(browser);
    browser.send(JSON.stringify({ type: "ready", tabToken: "logical-tab-real-boundary" }));
    const ready = await uplinkInbox.matching((m) => m.t === "client-ready");
    expect(ready.tabToken).toBe("logical-tab-real-boundary");
    uplink.send(JSON.stringify({ t: "snapshot", clientId: ready.clientId, msgs: [{ type: "clearMessages" }, { type: "messageChunk", text: "snap" }] }));
    expect(await browserInbox.next()).toEqual({ type: "clearMessages" });
    expect(await browserInbox.next()).toEqual({ type: "messageChunk", text: "snap" });

    // ---- host -> browser broadcast ----
    uplink.send(JSON.stringify({ t: "host", msg: { type: "agentStart" } }));
    expect(await browserInbox.next()).toEqual({ type: "agentStart" });

    // ---- browser -> host routing ----
    browser.send(JSON.stringify({ type: "send", text: "hello from the web" }));
    const routed = await uplinkInbox.matching((m) => m.t === "msg");
    expect(routed.msg).toEqual({ type: "send", text: "hello from the web" });
    expect(routed.clientId).toBe(ready.clientId);

    // ---- uplink drops -> browser told the device is offline ----
    uplink.close();
    await new Promise((r) => setTimeout(r, 100));
    browser.send(JSON.stringify({ type: "send", text: "anyone there?" }));
    const offline = await browserInbox.matching((m) => m.type === "error");
    expect(offline.text).toMatch(/offline/i);
    browser.close();
  });

  it("rejects a bad uplink token with the re-link close code", async () => {
    const ws = new WebSocket(`${wsBase}/uplink?token=bogus`);
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(CLOSE_BAD_TOKEN);
  });

  it("refuses an uplink protocol newer than the relay with a diagnostic close", async () => {
    const { json: started } = await post("/api/link/start", { name: "future protocol box" });
    await post("/api/link/approve", { code: started.code });
    const token: string = (await post("/api/link/poll", { code: started.code })).json.token;
    const ws = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(token)}`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ t: "hello", proto: REMOTE_PROTO_VERSION + 1 }));

    expect(await closed).toEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: `peer protocol ${REMOTE_PROTO_VERSION + 1} is newer than relay protocol ${REMOTE_PROTO_VERSION}`,
    });
  });

  it("refuses host traffic sent before hello with a diagnostic close", async () => {
    const { json: started } = await post("/api/link/start", { name: "missing hello box" });
    await post("/api/link/approve", { code: started.code });
    const token: string = (await post("/api/link/poll", { code: started.code })).json.token;
    const ws = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(token)}`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ t: "host", msg: { type: "agentStart" } }));

    expect(await closed).toEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "protocol hello required before host traffic",
    });
  });

  it("closes a WebSocket frame above the relay payload ceiling", async () => {
    const deviceId = (await (await fetch(`${base}/api/devices`)).json()).devices[0].deviceId;
    const ws = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await waitOpen(ws);
    ws.send(Buffer.alloc(MAX_WS_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
  });

  it("GET /api/config reports mock mode (no publishable key, open gate)", async () => {
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publishableKey: null, requiredFeature: null });
  });

  it("serves the pages and guards vendor traversal", async () => {
    for (const p of ["/", "/link", "/chat"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect((await manifest.json()).name).toBe("AFK Pilot");
    const icon = await fetch(`${base}/icon-192.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const worklet = await fetch(`${base}/vendor/media/pcm-worklet.js?v=deploy-fixture`);
    expect(worklet.status).toBe(200);
    expect(worklet.headers.get("content-type")).toBe("text/javascript");
    expect(worklet.headers.get("cache-control")).toBe("no-cache");
    expect(await worklet.text()).toBe(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(path.join(webRoot, "vendor", "media", "pcm-worklet.js"), "utf8"),
      ),
    );
    expect((await fetch(`${base}/vendor/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const displayJs = await fetch(`${base}/device-display.js`);
    expect(displayJs.status).toBe(200);
    expect(displayJs.headers.get("content-type")).toBe("text/javascript");
  });

  it("POST /api/link/start accepts optional client fields and GET /api/devices returns them", async () => {
    const started = await post("/api/link/start", {
      name: "DESKTOP-RHFLCK3 (Windows 11)",
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(started.status).toBe(200);
    expect(started.json.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await post("/api/link/approve", { code: started.json.code })).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const devices = (await (await fetch(`${base}/api/devices`)).json()).devices as Array<Record<string, unknown>>;
    const row = devices.find((d) => d.name === "DESKTOP-RHFLCK3 (Windows 11)");
    expect(row).toMatchObject({
      name: "DESKTOP-RHFLCK3 (Windows 11)",
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
  });

  it("POST /api/link/start without client fields still works and lists nulls", async () => {
    const started = await post("/api/link/start", { name: "legacy-only box" });
    expect(started.status).toBe(200);
    expect((await post("/api/link/approve", { code: started.json.code })).json.ok).toBe(true);
    const devices = (await (await fetch(`${base}/api/devices`)).json()).devices as Array<Record<string, unknown>>;
    const row = devices.find((d) => d.name === "legacy-only box");
    expect(row).toMatchObject({
      name: "legacy-only box",
      clientLabel: null,
      platform: null,
      osLabel: null,
    });
  });

  it("POST /api/link/start rejects invalid client fields", async () => {
    const badPlatform = await post("/api/link/start", { name: "x", platform: "android" });
    expect(badPlatform.status).toBe(400);
    expect(badPlatform.json).toEqual({ ok: false, error: "client" });

    const tooLong = await post("/api/link/start", { name: "x", clientLabel: "y".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json).toEqual({ ok: false, error: "client" });

    const control = await post("/api/link/start", { name: "x", osLabel: "Windows\n11" });
    expect(control.status).toBe(400);
    expect(control.json).toEqual({ ok: false, error: "client" });
  });

  it("uplink hello backfills client metadata when it differs from the stored row", async () => {
    const started = await post("/api/link/start", { name: "legacy-backfill box" });
    expect((await post("/api/link/approve", { code: started.json.code })).json.ok).toBe(true);
    const token: string = (await post("/api/link/poll", { code: started.json.code })).json.token;

    const before = ((await (await fetch(`${base}/api/devices`)).json()).devices as Array<Record<string, unknown>>)
      .find((d) => d.name === "legacy-backfill box");
    expect(before).toMatchObject({ clientLabel: null, platform: null, osLabel: null });

    const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(token)}`);
    await waitOpen(uplink);
    uplink.send(JSON.stringify({
      t: "hello",
      proto: 1,
      device: { name: "legacy-backfill box" },
      client: { clientLabel: "VS Code extension", platform: "win", osLabel: "Windows 11" },
    }));
    await expect
      .poll(async () => {
        const devices = (await (await fetch(`${base}/api/devices`)).json()).devices as Array<Record<string, unknown>>;
        return devices.find((d) => d.name === "legacy-backfill box");
      }, { timeout: 3000 })
      .toMatchObject({
        name: "legacy-backfill box",
        clientLabel: "VS Code extension",
        platform: "win",
        osLabel: "Windows 11",
      });

    // A later hello without client fields is a no-op (old-extension shape).
    uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "legacy-backfill box" } }));
    await new Promise((r) => setTimeout(r, 50));
    const still = ((await (await fetch(`${base}/api/devices`)).json()).devices as Array<Record<string, unknown>>)
      .find((d) => d.name === "legacy-backfill box");
    expect(still).toMatchObject({
      name: "legacy-backfill box",
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    uplink.close();
  });
});

// ---------------------------------------------------------------------------
// Auth gating with a STRICT session verifier + a required entitlement.
// good-A / good-B are entitled users; good-C, good-D, and good-E are signed-in
// but lack "remote" (good-D starts with no devices, so the re-link tests own
// their state).
// ---------------------------------------------------------------------------

class StrictVerifier implements SessionVerifier {
  async verify(token: string): Promise<SessionClaims | null> {
    if (token === "good-A") return { userId: "user_A", plans: [], features: ["remote"] };
    if (token === "good-B") return { userId: "user_B", plans: [], features: ["remote"] };
    if (token === "good-C") return { userId: "user_C", plans: [], features: [] }; // no entitlement
    if (token === "good-D") return { userId: "user_D", plans: [], features: [] }; // no entitlement, no devices yet
    if (token === "good-E") return { userId: "user_E", plans: [], features: [] }; // no entitlement, no devices yet
    return null;
  }
}

function postAuth(baseUrl: string, p: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${p}`, { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    json: await r.json(),
  }));
}

/** Open a /client socket and resolve with its close code (ignores errors). */
function clientCloseCode(url: string, headers?: Record<string, string>): Promise<number> {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  return new Promise<number>((resolve) => {
    ws.on("close", (c) => resolve(c));
    ws.on("error", () => {
      /* close carries the code */
    });
  });
}

describe("relay auth gating (strict verifier + required feature)", () => {
  let relay2: RelayServer;
  let base2: string;
  let wsBase2: string;
  let uplink: WebSocket;
  let uplinkInbox: WsInbox;
  let deviceId: string;

  beforeAll(async () => {
    let n = 0;
    const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
    const devices = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid2-${++n}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev2-${++n}`,
    });
    const hub = new Hub();
    relay2 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store,
      devices,
      sessions: new StrictVerifier(),
      requiredFeature: "remote",
      clerkPublishableKey: "pk_test_e2e",
      hub,
      log: () => {},
    });
    await new Promise<void>((r) => relay2.server.once("listening", () => r()));
    base2 = `http://127.0.0.1:${relay2.port()}`;
    wsBase2 = `ws://127.0.0.1:${relay2.port()}`;

    // Bring one device online, owned by user_A (approved with A's session).
    const { json: started } = await postAuth(base2, "/api/link/start", { name: "A's box" });
    const approved = await postAuth(base2, "/api/link/approve", { code: started.code }, "good-A");
    expect(approved.json).toEqual({ ok: true, deviceId: expect.any(String) });
    const token: string = (await postAuth(base2, "/api/link/poll", { code: started.code })).json.token;
    uplink = new WebSocket(`${wsBase2}/uplink?token=${encodeURIComponent(token)}`);
    uplinkInbox = new WsInbox(uplink);
    await waitOpen(uplink);
    uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "A's box" } }));

    const mine = (await (await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })).json()).devices;
    expect(mine).toHaveLength(1);
    deviceId = mine[0].deviceId;
  });

  afterAll(async () => {
    try {
      uplink.close();
    } catch {
      /* best effort */
    }
    await relay2.close();
  });

  it("GET /api/config hands out the publishable key + required feature", async () => {
    expect(await (await fetch(`${base2}/api/config`)).json()).toEqual({
      publishableKey: "pk_test_e2e",
      requiredFeature: "remote",
    });
  });

  it("POST /api/link/approve requires a verified session", async () => {
    const { json: started } = await postAuth(base2, "/api/link/start", { name: "no-auth box" });
    const res = await postAuth(base2, "/api/link/approve", { code: started.code });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ ok: false, error: "auth" });
  });

  it("POST /api/link/approve succeeds for an entitled user", async () => {
    const { json: started } = await postAuth(base2, "/api/link/start", { name: "B's box" });
    const res = await postAuth(base2, "/api/link/approve", { code: started.code }, "good-B");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, deviceId: expect.any(String) });
  });

  it("GET /api/devices lists ALL of the caller's devices (offline included), never others'", async () => {
    // No session -> 401.
    expect((await fetch(`${base2}/api/devices`)).status).toBe(401);
    // Owner A sees their live device; B sees only B's earlier-approved box,
    // offline (its uplink never connected) — and never A's.
    const asA = (await (await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })).json()).devices;
    const mineA = asA.find((d: any) => d.deviceId === deviceId);
    expect(mineA).toMatchObject({ online: true });
    const asB = (await (await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-B" } })).json()).devices;
    expect(asB.map((d: any) => d.name)).toEqual(["B's box"]);
    expect(asB[0]).toMatchObject({ online: false, clients: 0 });
    expect(asB.map((d: any) => d.deviceId)).not.toContain(deviceId);
  });

  it("DELETE /api/devices/{id}: owner-only revoke that kills the live uplink", async () => {
    // Not the owner -> 404 (existence not leaked), device untouched.
    expect((await fetch(`${base2}/api/devices/${deviceId}`, { method: "DELETE", headers: { authorization: "Bearer good-B" } })).status).toBe(404);
    // No session -> 401.
    expect((await fetch(`${base2}/api/devices/${deviceId}`, { method: "DELETE" })).status).toBe(401);

    // Owner removes a SECOND device of theirs (keep the shared one alive for
    // the other tests): link, approve, connect its uplink, then delete.
    const { json: started } = await postAuth(base2, "/api/link/start", { name: "A's doomed box" });
    expect((await postAuth(base2, "/api/link/approve", { code: started.code }, "good-A")).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const token: string = (await postAuth(base2, "/api/link/poll", { code: started.code })).json.token;
    const doomed = new WebSocket(`${wsBase2}/uplink?token=${encodeURIComponent(token)}`);
    await waitOpen(doomed);
    const closed = new Promise<number>((resolve) => doomed.on("close", (c) => resolve(c)));

    const doomedId = (
      (await (await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })).json()).devices as any[]
    ).find((d) => d.name === "A's doomed box").deviceId;
    const del = await fetch(`${base2}/api/devices/${doomedId}`, { method: "DELETE", headers: { authorization: "Bearer good-A" } });
    expect(await del.json()).toEqual({ ok: true });

    expect(await closed).toBe(CLOSE_BAD_TOKEN); // live uplink terminated: re-link, don't retry
    // Token is dead and the device is gone from the list.
    const again = new WebSocket(`${wsBase2}/uplink?token=${encodeURIComponent(token)}`);
    expect(await new Promise<number>((r) => again.on("close", (c) => r(c)))).toBe(CLOSE_BAD_TOKEN);
    const listNow = (await (await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })).json()).devices;
    expect(listNow.map((d: any) => d.name)).not.toContain("A's doomed box");
  });

  it("POST /api/device/unlink revokes its own token and kills the live uplink", async () => {
    const { json: started } = await postAuth(base2, "/api/link/start", { name: "A's self-unlink box" });
    const approved = await postAuth(base2, "/api/link/approve", { code: started.code }, "good-A");
    expect(approved.json).toEqual({ ok: true, deviceId: expect.any(String) });
    const token: string = (await postAuth(base2, "/api/link/poll", { code: started.code })).json.token;
    const self = new WebSocket(`${wsBase2}/uplink?token=${encodeURIComponent(token)}`);
    await waitOpen(self);
    const closed = new Promise<number>((resolve) => self.on("close", (c) => resolve(c)));

    const res = await fetch(`${base2}/api/device/unlink`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await closed).toBe(CLOSE_BAD_TOKEN);

    const mine = (await (
      await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })
    ).json()).devices;
    expect(mine.map((d: any) => d.deviceId)).not.toContain(approved.json.deviceId);
  });

  it("POST /api/device/unlink rejects garbage or absent tokens without revoking", async () => {
    for (const authorization of ["Bearer garbage", undefined]) {
      const headers = authorization ? { authorization } : undefined;
      const res = await fetch(`${base2}/api/device/unlink`, { method: "POST", headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "token" });
    }
    const mine = (await (
      await fetch(`${base2}/api/devices`, { headers: { authorization: "Bearer good-A" } })
    ).json()).devices;
    expect(mine.map((d: any) => d.deviceId)).toContain(deviceId);
    expect(uplink.readyState).toBe(WebSocket.OPEN);
  });

  it("GET /api/me reports entitlement (limits null for entitled users)", async () => {
    expect((await fetch(`${base2}/api/me`)).status).toBe(401);
    const me = await (await fetch(`${base2}/api/me`, { headers: { authorization: "Bearer good-A" } })).json();
    expect(me).toEqual({ userId: "user_A", entitled: true, limits: null });
    // relay2 has no freeTier -> unentitled users are hard-gated, limits null.
    const meC = await (await fetch(`${base2}/api/me`, { headers: { authorization: "Bearer good-C" } })).json();
    expect(meC).toEqual({ userId: "user_C", entitled: false, limits: null });
  });

  it("/client rejects: no session (4004), wrong owner (4003), unentitled (4005)", async () => {
    const target = `${wsBase2}/client?device=${encodeURIComponent(deviceId)}`;
    expect(await clientCloseCode(target)).toBe(CLOSE_AUTH_REQUIRED); // no cookie/header
    expect(await clientCloseCode(target, { cookie: "__session=good-B" })).toBe(4003); // B doesn't own it
    expect(await clientCloseCode(target, { authorization: "Bearer good-C" })).toBe(CLOSE_ENTITLEMENT_REQUIRED); // no feature
  });

  it("/client connects for the owner and routes ready -> snapshot", async () => {
    const browser = new WebSocket(`${wsBase2}/client?device=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: "Bearer good-A" },
    });
    const browserInbox = new WsInbox(browser);
    await waitOpen(browser);
    browser.send(JSON.stringify({ type: "ready" }));
    const ready = await uplinkInbox.matching((m) => m.t === "client-ready");
    uplink.send(JSON.stringify({ t: "snapshot", clientId: ready.clientId, msgs: [{ type: "messageChunk", text: "hi-A" }] }));
    expect(await browserInbox.next()).toEqual({ type: "messageChunk", text: "hi-A" });
    browser.close();
  });
});

// ---------------------------------------------------------------------------
// Free tier: signed-in users WITHOUT the feature (good-C) get capped access —
// a device limit at approve and a daily `send` quota at /client — instead of
// the hard 403/4005 gate. Entitled users are never metered.
// ---------------------------------------------------------------------------

describe("free tier (unentitled users get capped access)", () => {
  let relay4: RelayServer;
  let base4: string;
  let wsBase4: string;
  let uplink: WebSocket;
  let uplinkInbox: WsInbox;
  let deviceId: string;

  beforeAll(async () => {
    let n = 0;
    const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
    const devices = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid4-${++n}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev4-${++n}`,
    });
    const hub = new Hub();
    relay4 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store,
      devices,
      sessions: new StrictVerifier(),
      requiredFeature: "remote",
      freeTier: { devices: 1, weeklyMsgs: 2, usage: new InMemoryUsageStore() },
      hub,
      log: () => {},
    });
    await new Promise<void>((r) => relay4.server.once("listening", () => r()));
    base4 = `http://127.0.0.1:${relay4.port()}`;
    wsBase4 = `ws://127.0.0.1:${relay4.port()}`;

    // good-C (no feature) links their one free device; extension-sim online.
    const { json: started } = await postAuth(base4, "/api/link/start", { name: "C's free box" });
    expect((await postAuth(base4, "/api/link/approve", { code: started.code }, "good-C")).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const token: string = (await postAuth(base4, "/api/link/poll", { code: started.code })).json.token;
    uplink = new WebSocket(`${wsBase4}/uplink?token=${encodeURIComponent(token)}`);
    uplinkInbox = new WsInbox(uplink);
    await waitOpen(uplink);
    uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "C's free box" } }));
    const mine = (await (await fetch(`${base4}/api/devices`, { headers: { authorization: "Bearer good-C" } })).json())
      .devices;
    deviceId = mine[0].deviceId;
  });

  afterAll(async () => {
    try {
      uplink.close();
    } catch {
      /* best effort */
    }
    await relay4.close();
  });

  it("second device for an unentitled user hits the cap with a distinct reason", async () => {
    const { json: started } = await postAuth(base4, "/api/link/start", { name: "C's second box" });
    const res = await postAuth(base4, "/api/link/approve", { code: started.code }, "good-C");
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ ok: false, error: "entitlement", reason: "device-limit", limit: 1 });
  });

  it("re-linking the SAME machine supersedes its device instead of hitting the cap", async () => {
    // The bug this pins: linking is per-row, so a machine that re-linked (after
    // a reinstall, a relay-URL change, a failed connection) minted a SECOND
    // device and bounced its owner off the 1-device free tier — a paywall for
    // hardware they already had. `name` cannot carry identity; the install id
    // can. Same install id => the old row is revoked and the cap is never hit.
    const install = "install-guid-same-machine";
    const first = await postAuth(base4, "/api/link/start", { name: "D's laptop", installId: install });
    expect((await postAuth(base4, "/api/link/approve", { code: first.json.code }, "good-D")).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const firstToken: string = (await postAuth(base4, "/api/link/poll", { code: first.json.code })).json.token;

    const again = await postAuth(base4, "/api/link/start", { name: "D's laptop", installId: install });
    const res = await postAuth(base4, "/api/link/approve", { code: again.json.code }, "good-D");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, deviceId: expect.any(String) });

    // Superseded, not accumulated: still exactly one live device, and the old
    // token is dead so a stale uplink for this machine cannot linger.
    const devices = (await (await fetch(`${base4}/api/devices`, { headers: { authorization: "Bearer good-D" } })).json())
      .devices as any[];
    expect(devices.map((d) => d.name)).toEqual(["D's laptop"]);
    const stale = new WebSocket(`${wsBase4}/uplink?token=${encodeURIComponent(firstToken)}`);
    expect(await new Promise<number>((r) => stale.on("close", (c) => r(c)))).toBe(CLOSE_BAD_TOKEN);
  });

  it("two discriminated clients on one machine share a free-tier slot", async () => {
    const machine = "install-guid-discriminated-machine";
    const extension = await postAuth(base4, "/api/link/start", { name: "E's extension", installId: machine });
    expect((await postAuth(base4, "/api/link/approve", { code: extension.json.code }, "good-E")).status).toBe(200);

    const desktop = await postAuth(base4, "/api/link/start", {
      name: "E's desktop",
      installId: `${machine}:desktop`,
    });
    const res = await postAuth(base4, "/api/link/approve", { code: desktop.json.code }, "good-E");
    expect(res.status).toBe(200);

    const devices = (await (await fetch(`${base4}/api/devices`, { headers: { authorization: "Bearer good-E" } })).json())
      .devices as any[];
    expect(devices).toHaveLength(2);
  });

  it("rejects an unrecognized client discriminator at link start", async () => {
    const res = await postAuth(base4, "/api/link/start", {
      name: "E's unknown client",
      installId: "install-guid-discriminated-machine:phone",
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, error: "install-id" });
  });

  it("a DIFFERENT machine on the free tier still hits the cap", async () => {
    // The dedupe must not become a way around the cap: a second machine is a
    // second device, install id or not.
    const other = await postAuth(base4, "/api/link/start", { name: "D's desktop", installId: "install-guid-other" });
    const res = await postAuth(base4, "/api/link/approve", { code: other.json.code }, "good-D");
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ ok: false, error: "entitlement", reason: "device-limit", limit: 1 });
  });

  it("entitled users bypass the device cap", async () => {
    for (const name of ["A box 1", "A box 2"]) {
      const { json: started } = await postAuth(base4, "/api/link/start", { name });
      expect((await postAuth(base4, "/api/link/approve", { code: started.code }, "good-A")).json).toEqual({
        ok: true,
        deviceId: expect.any(String),
      });
    }
  });

  it("unentitled owner connects, sync is free, sends AND steers meter, over-quota bounces", async () => {
    const browser = new WebSocket(`${wsBase4}/client?device=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: "Bearer good-C" },
    });
    const browserInbox = new WsInbox(browser);
    await waitOpen(browser); // NOT 4005 — the free tier admits them
    browser.send(JSON.stringify({ type: "ready" }));
    await uplinkInbox.matching((m) => m.t === "client-ready"); // ready unmetered

    // A steer is a user prompt injected into a running turn — it meters
    // exactly like a send, or one metered prompt would buy unlimited free
    // steering for the length of the turn.
    browser.send(JSON.stringify({ type: "send", text: "m1" }));
    browser.send(JSON.stringify({ type: "steerSend", text: "m2" }));
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.text).toBe("m1");
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.text).toBe("m2");

    // The weekly allowance (2) is now spent, which makes the next two frames a
    // clean test of what quota means (owner, 2026-07-30):
    // a BARE plan verdict is free — "agent replies and approvals are free" is a
    // published promise — so it routes to the host even at the limit…
    browser.send(JSON.stringify({ type: "exitPlanAnswer", requestId: 1, verdict: "approved" }));
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.type).toBe("exitPlanAnswer");

    // …while a verdict carrying the user's TYPED comment is a message they
    // wrote, reaching the model as their words, so it does charge and bounces.
    browser.send(JSON.stringify({
      type: "exitPlanAnswer", requestId: 2, verdict: "rejected", comment: "plan the auth part again",
    }));
    expect((await browserInbox.matching((m) => m.type === "error")).text).toMatch(/Free plan limit/);

    // Third turn-running frame (a workflow control this time — the host runs
    // it as a real `/workflow …` slash turn) is over the 2/week quota:
    // browser gets the upgrade error, the uplink must NOT see it — proven by
    // ordering (the next frame the uplink receives is the client-ready of a
    // follow-up ready, not m3).
    browser.send(JSON.stringify({ type: "workflowControl", action: "pause", displayName: "wf" }));
    const err = await browserInbox.matching((m) => m.type === "error");
    expect(err.text).toMatch(/Free plan limit/);

    // A summarize request is NOT text the user wrote, so it must not eat the
    // weekly allowance — it routes to the host with the quota already spent.
    // (Capped per minute, though; the burst half of that pair is proven in the
    // rate-limit suite, which is the only one configuring a messageRate.)
    browser.send(JSON.stringify({ type: "summarizeSpeech", requestId: 9, text: "a reply" }));
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.type).toBe("summarizeSpeech");
    browser.send(JSON.stringify({ type: "ready" }));
    const next = await uplinkInbox.matching((m) => m.t === "client-ready" || m.t === "msg");
    expect(next.t).toBe("client-ready");
    browser.close();
  });

  it("GET /api/me surfaces the free-tier usage for the meter", async () => {
    // Runs after the metering test: good-C has spent their 2-message week.
    const me = await (await fetch(`${base4}/api/me`, { headers: { authorization: "Bearer good-C" } })).json();
    expect(me).toEqual({
      userId: "user_C",
      entitled: false,
      limits: { weeklyMsgs: 2, used: 2, devices: 1, maxPerMinute: null, resetsAt: expect.any(String) },
    });
    // resetsAt is the next Tuesday 17:00 Europe/Warsaw — in the future.
    expect(new Date(me.limits.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("a hung usage store cannot delay voice rejection, then FAILS OPEN", async () => {
    // Same relay wiring but a store that throws — availability over
    // enforcement (the counter is a habit ceiling, not a billing meter).
    let markIncrementStarted!: () => void;
    const incrementStarted = new Promise<void>((resolve) => {
      markIncrementStarted = resolve;
    });
    let releaseIncrement!: () => void;
    const heldIncrement = new Promise<void>((_resolve, reject) => {
      releaseIncrement = () => reject(new Error("db down"));
    });
    let holdFirstIncrement = true;
    const broken: UsageStore = {
      increment: async () => {
        if (holdFirstIncrement) {
          holdFirstIncrement = false;
          markIncrementStarted();
          await heldIncrement;
        }
        throw new Error("db down");
      },
      peek: async () => {
        throw new Error("db down");
      },
    };
    let n5 = 0;
    const store5 = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n5++ * 7) % 32) });
    const devices5 = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid5-${++n5}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev5-${++n5}`,
    });
    const hub5 = new Hub();
    const relay5 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store: store5,
      devices: devices5,
      sessions: new StrictVerifier(),
      requiredFeature: "remote",
      freeTier: { devices: 1, weeklyMsgs: 1, usage: broken },
      voiceChunkRate: { perMinute: 2, limiter: new MinuteRateLimiter(Date.now) },
      hub: hub5,
      log: () => {},
    });
    await new Promise<void>((r) => relay5.server.once("listening", () => r()));
    const b5 = `http://127.0.0.1:${relay5.port()}`;
    const w5 = `ws://127.0.0.1:${relay5.port()}`;
    try {
      const { json: started } = await postAuth(b5, "/api/link/start", { name: "outage box" });
      await postAuth(b5, "/api/link/approve", { code: started.code }, "good-C");
      const token: string = (await postAuth(b5, "/api/link/poll", { code: started.code })).json.token;
      const up = new WebSocket(`${w5}/uplink?token=${encodeURIComponent(token)}`);
      const upInbox = new WsInbox(up);
      await waitOpen(up);
      up.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "outage box" } }));
      const devId = (
        await (await fetch(`${b5}/api/devices`, { headers: { authorization: "Bearer good-C" } })).json()
      ).devices[0].deviceId;
      const client = new WebSocket(`${w5}/client?device=${encodeURIComponent(devId)}`, {
        headers: { authorization: "Bearer good-C" },
      });
      await waitOpen(client);
      const rateClosed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
      client.send(JSON.stringify({ type: "send", text: "held by usage store" }));
      await incrementStarted;

      // These arrive while the send is still awaiting increment(). The third
      // chunk must synchronously consume the device-scoped ingress bucket and
      // close the socket rather than sitting behind frameChain.
      client.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
      client.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
      client.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
      expect(await rateClosed).toBe(1008);
      releaseIncrement();
      expect((await upInbox.matching((m) => m.t === "msg")).msg.text).toBe("held by usage store");

      const retry = new WebSocket(`${w5}/client?device=${encodeURIComponent(devId)}`, {
        headers: { authorization: "Bearer good-C" },
      });
      await waitOpen(retry);
      // Two sends against a 1-message limit: with the store down BOTH must
      // flow through (fail open), none may bounce.
      retry.send(JSON.stringify({ type: "send", text: "o1" }));
      retry.send(JSON.stringify({ type: "send", text: "o2" }));
      expect((await upInbox.matching((m) => m.t === "msg" && m.msg.type === "send")).msg.text).toBe("o1");
      expect((await upInbox.matching((m) => m.t === "msg" && m.msg.type === "send")).msg.text).toBe("o2");
      retry.close();
      up.close();
    } finally {
      await relay5.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Burst cap: the per-minute `send` limit applies to EVERYONE (mock/open gate
// here — no feature, no free tier), sync traffic stays free.
// ---------------------------------------------------------------------------

describe("burst cap (messages per minute, all users)", () => {
  let relay5: RelayServer;
  let base5: string;
  let wsBase5: string;

  beforeAll(async () => {
    let n = 0;
    const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
    const devices = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid5-${++n}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev5-${++n}`,
    });
    relay5 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store,
      devices,
      sessions: new MockSessionVerifier(true),
      requiredFeature: undefined,
      messageRate: { perMinute: 2, limiter: new MinuteRateLimiter(Date.now) },
      voiceChunkRate: { perMinute: 2, limiter: new MinuteRateLimiter(Date.now) },
      hub: new Hub(),
      log: () => {},
    });
    await new Promise<void>((r) => relay5.server.once("listening", () => r()));
    base5 = `http://127.0.0.1:${relay5.port()}`;
    wsBase5 = `ws://127.0.0.1:${relay5.port()}`;
  });

  afterAll(async () => {
    await relay5.close();
  });

  it("third send within a minute bounces with the slow-down error", async () => {
    const { json: started } = await postAuth(base5, "/api/link/start", { name: "bursty box" });
    expect((await postAuth(base5, "/api/link/approve", { code: started.code })).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const token: string = (await postAuth(base5, "/api/link/poll", { code: started.code })).json.token;
    const uplink = new WebSocket(`${wsBase5}/uplink?token=${encodeURIComponent(token)}`);
    const uplinkInbox = new WsInbox(uplink);
    await waitOpen(uplink);
    uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "bursty box" } }));
    const deviceId = (await (await fetch(`${base5}/api/devices`)).json()).devices[0].deviceId;

    const browser = new WebSocket(`${wsBase5}/client?device=${encodeURIComponent(deviceId)}`);
    const browserInbox = new WsInbox(browser);
    await waitOpen(browser);
    browser.send(JSON.stringify({ type: "ready" }));
    await uplinkInbox.matching((m) => m.t === "client-ready");

    browser.send(JSON.stringify({ type: "send", text: "b1" }));
    browser.send(JSON.stringify({ type: "send", text: "b2" }));
    browser.send(JSON.stringify({ type: "send", text: "b3" }));
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.text).toBe("b1");
    expect((await uplinkInbox.matching((m) => m.t === "msg")).msg.text).toBe("b2");
    const err = await browserInbox.matching((m) => m.type === "error");
    expect(err.text).toMatch(/Slow down/);

    // A summarize request rides the same cap (2026-08-01). This discriminates:
    // an UNCAPPED type skips the limiter entirely and would route to the host
    // even with the bucket spent, so a bounce here is proof it is capped. Each
    // one costs a billed xAI call on the user's key, and the setting defaults
    // on, so unbounded it is a free call the quota never sees.
    browser.send(JSON.stringify({ type: "summarizeSpeech", requestId: 7, text: "a reply" }));
    expect((await browserInbox.matching((m) => m.type === "error")).text).toMatch(/Slow down/);

    // Ordering proof: the next uplink frame is a client-ready — neither b3 nor
    // the summarize reached the host.
    browser.send(JSON.stringify({ type: "ready" }));
    const next = await uplinkInbox.matching((m) => m.t === "client-ready" || m.t === "msg");
    expect(next.t).toBe("client-ready");
    browser.close();
    uplink.close();
  });

  it("audio chunks have a device-scoped transport bucket that survives reconnect", async () => {
    const { json: started } = await postAuth(base5, "/api/link/start", { name: "audio box" });
    await postAuth(base5, "/api/link/approve", { code: started.code });
    const token: string = (await postAuth(base5, "/api/link/poll", { code: started.code })).json.token;
    const up = new WebSocket(`${wsBase5}/uplink?token=${encodeURIComponent(token)}`);
    const upInbox = new WsInbox(up);
    await waitOpen(up);
    const audioDeviceId = (await (await fetch(`${base5}/api/devices`)).json()).devices
      .find((d: any) => d.name === "audio box").deviceId;

    const browser = new WebSocket(`${wsBase5}/client?device=${encodeURIComponent(audioDeviceId)}`);
    await waitOpen(browser);
    const oversizedClosed = new Promise<number>((resolve) => browser.on("close", (code) => resolve(code)));
    browser.send(JSON.stringify({ type: "remoteVoiceChunk", data: "A".repeat(512 * 1024) }));
    expect(await oversizedClosed).toBe(1009);

    const recording = new WebSocket(`${wsBase5}/client?device=${encodeURIComponent(audioDeviceId)}`);
    await waitOpen(recording);
    const rateClosed = new Promise<number>((resolve) => recording.on("close", (code) => resolve(code)));
    recording.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
    recording.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
    recording.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
    expect((await upInbox.matching((m) => m.t === "msg")).msg.type).toBe("remoteVoiceChunk");
    expect((await upInbox.matching((m) => m.t === "msg")).msg.type).toBe("remoteVoiceChunk");
    expect(await rateClosed).toBe(1008);

    const reconnected = new WebSocket(`${wsBase5}/client?device=${encodeURIComponent(audioDeviceId)}`);
    await waitOpen(reconnected);
    const reconnectClosed = new Promise<number>((resolve) => reconnected.on("close", (code) => resolve(code)));
    reconnected.send(JSON.stringify({ type: "remoteVoiceChunk", data: "AA==" }));
    expect(await reconnectClosed).toBe(1008);
    up.close();
  });
});

// ---------------------------------------------------------------------------
// Admission race: the upgrade completes before the server's async verify /
// ownership checks (real network calls in production), so a peer's first
// frames — the extension's `hello`, the page's `ready` — arrive while the
// server is still awaiting. They must be buffered and replayed, not lost.
// Caught live by scripts/browser-e2e.mjs (chat page hung at "Connecting").
// ---------------------------------------------------------------------------

describe("admission race: frames sent at open survive slow verify", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let relay3: RelayServer;
  let base3: string;
  let wsBase3: string;
  const hubLog: string[] = [];

  beforeAll(async () => {
    let n = 0;
    const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
    const fast = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid3-${++n}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev3-${++n}`,
    });
    // 75ms on the paths /uplink and /client await during admission.
    const slowDevices: DeviceRegistry = {
      issue: (name, userId) => fast.issue(name, userId),
      verify: async (token) => {
        await sleep(75);
        return fast.verify(token);
      },
      revoke: (id) => fast.revoke(id),
      listByUser: async (userId) => {
        await sleep(75);
        return fast.listByUser(userId);
      },
      findOwned: async (deviceId, userId) => {
        await sleep(75);
        return fast.findOwned(deviceId, userId);
      },
      updateClient: (deviceId, client) => fast.updateClient(deviceId, client),
    };
    const strict = new StrictVerifier();
    const slowSessions: SessionVerifier = {
      verify: async (token) => {
        await sleep(75);
        return strict.verify(token);
      },
    };
    relay3 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store,
      devices: slowDevices,
      sessions: slowSessions,
      requiredFeature: "remote",
      hub: new Hub((l) => hubLog.push(l)),
      log: () => {},
    });
    await new Promise<void>((r) => relay3.server.once("listening", () => r()));
    base3 = `http://127.0.0.1:${relay3.port()}`;
    wsBase3 = `ws://127.0.0.1:${relay3.port()}`;
  });

  afterAll(async () => {
    await relay3.close();
  });

  it("uplink hello + client ready sent inside the open callback both arrive", async () => {
    const { json: started } = await postAuth(base3, "/api/link/start", { name: "racy box" });
    expect((await postAuth(base3, "/api/link/approve", { code: started.code }, "good-A")).json).toEqual({
      ok: true,
      deviceId: expect.any(String),
    });
    const token: string = (await postAuth(base3, "/api/link/poll", { code: started.code })).json.token;

    // hello fires the instant the socket opens — during the 75ms verify.
    const uplink = new WebSocket(`${wsBase3}/uplink?token=${encodeURIComponent(token)}`);
    const uplinkInbox = new WsInbox(uplink);
    uplink.on("open", () => uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "racy box" } })));
    // The buffered hello is replayed into the hub after admission.
    await expect
      .poll(() => hubLog.some((l) => l.includes("hello")), { timeout: 3000 })
      .toBe(true);

    const deviceId = (await (
      await fetch(`${base3}/api/devices`, { headers: { authorization: "Bearer good-A" } })
    ).json()).devices[0].deviceId;

    // ready fires at open — during verify + ownership lookup (150ms of awaits).
    const browser = new WebSocket(`${wsBase3}/client?device=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: "Bearer good-A" },
    });
    browser.on("open", () => browser.send(JSON.stringify({ type: "ready" })));
    const ready = await uplinkInbox.matching((m) => m.t === "client-ready");
    expect(ready.clientId).toBeTruthy();
    browser.close();
    uplink.close();
  });

  it("closes a peer that overflows the authentication-pending frame buffer", async () => {
    const browser = new WebSocket(`${wsBase3}/client?device=anything`, {
      headers: { authorization: "Bearer good-A" },
    });
    const closed = new Promise<number>((resolve) => browser.on("close", (code) => resolve(code)));
    browser.on("open", () => {
      for (let i = 0; i <= MAX_AUTH_PENDING_FRAMES; i++) {
        browser.send(JSON.stringify({ type: "ready", i }));
      }
    });
    expect(await closed).toBe(1009);
  });

  it("rejects one pre-auth frame above the small admission byte budget", async () => {
    expect(MAX_AUTH_PENDING_BYTES).toBeLessThan(MAX_WS_PAYLOAD_BYTES);
    const browser = new WebSocket(`${wsBase3}/client?device=anything`, {
      headers: { authorization: "Bearer good-A" },
    });
    const closed = new Promise<number>((resolve) => browser.on("close", (code) => resolve(code)));
    browser.on("open", () => {
      browser.send(JSON.stringify({ type: "ready", padding: "x".repeat(MAX_AUTH_PENDING_BYTES) }));
    });
    expect(await closed).toBe(1009);
  });
});

// Heartbeat: proxies (Cloudflare ~100s) kill idle WebSockets, so the relay
// pings every socket on pingIntervalMs. The ws client lib auto-pongs, exactly
// like browsers do — we assert the ping actually reaches an idle peer.
describe("relay ws heartbeat", () => {
  let relay6: RelayServer;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterAll(async () => {
    await relay6.close();
  });

  it("pings an idle uplink so proxies see traffic", async () => {
    let n = 0;
    const store = new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) });
    const devices = new InMemoryDeviceRegistry({
      now: Date.now,
      randomUUID: () => `kid6-${++n}`,
      randomBytes: (size) => cryptoRandomBytes(size),
      randomId: () => `dev6-${++n}`,
    });
    relay6 = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store,
      devices,
      sessions: new MockSessionVerifier(true),
      requiredFeature: undefined,
      pingIntervalMs: 40,
      hub: new Hub(),
      log: () => {},
    });
    await new Promise<void>((r) => relay6.server.once("listening", () => r()));
    const base6 = `http://127.0.0.1:${relay6.port()}`;

    const { json: started } = await postAuth(base6, "/api/link/start", { name: "idle box" });
    await postAuth(base6, "/api/link/approve", { code: started.code });
    const token: string = (await postAuth(base6, "/api/link/poll", { code: started.code })).json.token;

    const uplink = new WebSocket(`ws://127.0.0.1:${relay6.port()}/uplink?token=${encodeURIComponent(token)}`);
    const pinged = new Promise<boolean>((resolve) => {
      uplink.on("ping", () => resolve(true));
    });
    await new Promise<void>((r) => uplink.on("open", () => r()));
    // Send nothing: the idle socket must still see server pings, and the
    // auto-pong must keep it from being reaped across several intervals.
    expect(await pinged).toBe(true);
    await sleep(150);
    expect(uplink.readyState).toBe(WebSocket.OPEN);
    uplink.close();
  });
});
