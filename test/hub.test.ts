import { describe, it, expect } from "vitest";
import { Hub } from "../src/hub.js";
import { REMOTE_PROTO_VERSION, TRANSPORT_PROBE_TYPE } from "../src/frames.js";

class FakeSender {
  sent: string[] = [];
  readyState?: number;
  closed = false;
  /** Stand-in for the page's persisted outbox. close() must not touch it. */
  outbox: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  json(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function hello(hub: Hub, deviceId = "devA", proto = REMOTE_PROTO_VERSION) {
  return hub.fromUplink(deviceId, JSON.stringify({ t: "hello", proto }));
}

describe("Hub routing", () => {
  it("host frames broadcast to every client of that device only", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const c1 = new FakeSender();
    const c2 = new FakeSender();
    const other = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    hub.addClient("devA", c1);
    hub.addClient("devA", c2);
    hub.addClient("devB", other);
    hub.fromUplink("devA", JSON.stringify({ t: "host", msg: { type: "messageChunk", text: "hi" } }));
    expect(c1.json()).toEqual([{ type: "messageChunk", text: "hi" }]);
    expect(c2.json()).toEqual([{ type: "messageChunk", text: "hi" }]);
    expect(other.sent).toEqual([]);
  });

  it("host-to frames route to the listed clients that are still connected", () => {
    const hub = new Hub();
    const c1 = new FakeSender();
    const c2 = new FakeSender();
    const c3 = new FakeSender();
    hub.attachUplink("devA", new FakeSender());
    hello(hub);
    const id1 = hub.addClient("devA", c1);
    hub.addClient("devA", c2);
    const id3 = hub.addClient("devA", c3);
    hub.removeClient("devA", id3);

    expect(() => hub.fromUplink("devA", JSON.stringify({
      t: "host-to",
      clientIds: [id1, id3, "already-gone"],
      msg: { type: "messageChunk", text: "group" },
    }))).not.toThrow();
    expect(c1.json()).toEqual([{ type: "messageChunk", text: "group" }]);
    expect(c2.sent).toEqual([]);
    expect(c3.sent).toEqual([]);
  });

  it("a client's ready becomes client-ready; the snapshot routes back to just that client", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const c1 = new FakeSender();
    const c2 = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id1 = hub.addClient("devA", c1);
    hub.addClient("devA", c2);
    up.sent = []; // drop the clients-count notifications

    expect(hub.fromClient("devA", id1, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }))).toBe("routed");
    expect(up.json()).toEqual([{ t: "client-ready", clientId: id1, tabToken: "logical-tab-1" }]);

    hub.fromUplink("devA", JSON.stringify({ t: "snapshot", clientId: id1, msgs: [{ type: "clearMessages" }, { type: "messageChunk", text: "x" }] }));
    expect(c1.json()).toEqual([{ type: "clearMessages" }, { type: "messageChunk", text: "x" }]);
    expect(c2.sent).toEqual([]);
  });

  it("non-ready client messages wrap into msg frames for the uplink", () => {
    const hub = new Hub();
    const up = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", new FakeSender());
    up.sent = [];
    hub.fromClient("devA", id, JSON.stringify({ type: "send", text: "do it" }));
    expect(up.json()).toEqual([{ t: "msg", clientId: id, msg: { type: "send", text: "do it" } }]);
  });

  it("omits an absent or non-string ready tab token", () => {
    const hub = new Hub();
    const up = new FakeSender();
    hub.attachUplink("devA", up);
    const id = hub.addClient("devA", new FakeSender());
    up.sent = [];

    hub.fromClient("devA", id, JSON.stringify({ type: "ready" }));
    hub.fromClient("devA", id, JSON.stringify({ type: "ready", tabToken: 42 }));

    expect(up.json()).toEqual([
      { t: "client-ready", clientId: id },
      { t: "client-ready", clientId: id },
    ]);
  });

  it("reports offline when no uplink, dropped on garbage", () => {
    const hub = new Hub();
    const id = hub.addClient("devA", new FakeSender());
    expect(hub.fromClient("devA", id, JSON.stringify({ type: "send", text: "x" }))).toBe("offline");
    expect(hub.fromClient("devA", id, "garbage")).toBe("dropped");
  });

  it("refuses a second uplink for the same device", () => {
    const hub = new Hub();
    expect(hub.attachUplink("devA", new FakeSender())).toBe(true);
    expect(hub.attachUplink("devA", new FakeSender())).toBe(false);
    hub.detachUplink("devA");
    expect(hub.attachUplink("devA", new FakeSender())).toBe(true);
  });

  it("a recreated host gets tab tokens, so an adverse-order reconnect can transfer ownership", () => {
    const hub = new Hub();
    const first = new FakeSender();
    hub.attachUplink("devA", first);
    const id1 = hub.addClient("devA", new FakeSender());
    const id2 = hub.addClient("devA", new FakeSender());
    hub.fromClient("devA", id1, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }));
    hub.fromClient("devA", id2, JSON.stringify({ type: "ready", tabToken: "other-tab" }));
    hub.detachUplink("devA");

    // A fresh extension host must rebuild ownership from the surviving socket.
    const reconnected = new FakeSender();
    expect(hub.attachUplink("devA", reconnected)).toBe(true);
    expect(reconnected.json()).toEqual([
      { t: "clients", count: 2 },
      { t: "client-ready", clientId: id1, tabToken: "logical-tab-1" },
      { t: "client-ready", clientId: id2, tabToken: "other-tab" },
    ]);

    // The same logical tab reconnects before the old socket's delayed close.
    // The hub evicts the predecessor so the host sees client-left then
    // client-ready, not two live claims on one token.
    const replacement = hub.addClient("devA", new FakeSender());
    hub.fromClient("devA", replacement, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }));
    const frames = reconnected.json();
    const leftAt = frames.findIndex((frame) =>
      (frame as { t?: string; clientId?: string }).t === "client-left"
      && (frame as { clientId?: string }).clientId === id1,
    );
    const readyAt = frames.findIndex((frame) =>
      (frame as { t?: string; clientId?: string }).t === "client-ready"
      && (frame as { clientId?: string }).clientId === replacement,
    );
    expect(leftAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(leftAt);
    expect(frames[readyAt]).toEqual({
      t: "client-ready", clientId: replacement, tabToken: "logical-tab-1",
    });
    expect(hub.clientCount("devA")).toBe(2);
  });

  it("a replacement socket's ready-with-token precedes resumeSession; the predecessor has already left", () => {
    const hub = new Hub();
    const up = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const old = hub.addClient("devA", new FakeSender());
    hub.fromClient("devA", old, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }));
    up.sent = [];

    const replacement = hub.addClient("devA", new FakeSender());
    hub.fromClient("devA", replacement, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }));
    hub.fromClient("devA", replacement, JSON.stringify({ type: "resumeSession", id: "s1" }));

    const frames = up.json();
    const leftAt = frames.findIndex((frame) => (frame as { t?: string }).t === "client-left");
    const readyAt = frames.findIndex((frame) => (frame as { t?: string }).t === "client-ready");
    const resumeAt = frames.findIndex((frame) => (frame as { t?: string }).t === "msg");
    expect(leftAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(leftAt);
    expect(resumeAt).toBeGreaterThan(readyAt);
    expect(frames[leftAt]).toEqual({ t: "client-left", clientId: old });
    expect(frames[readyAt]).toEqual({
      t: "client-ready", clientId: replacement, tabToken: "logical-tab-1",
    });
    expect(frames[resumeAt]).toEqual({
      t: "msg", clientId: replacement, msg: { type: "resumeSession", id: "s1" },
    });
    hub.removeClient("devA", old);
    expect(up.json().filter((frame) => (frame as { t?: string }).t === "client-left")).toHaveLength(1);
  });

  it("a client that disconnects during an uplink outage is not replayed on reconnect", () => {
    const hub = new Hub();
    hub.attachUplink("devA", new FakeSender());
    const stayed = hub.addClient("devA", new FakeSender());
    const left = hub.addClient("devA", new FakeSender());
    hub.detachUplink("devA");
    hub.removeClient("devA", left);

    const reconnected = new FakeSender();
    hub.attachUplink("devA", reconnected);
    expect(reconnected.json()).toEqual([
      { t: "clients", count: 1 },
      { t: "client-ready", clientId: stayed },
    ]);
  });

  it("retains a ready token received while the uplink is offline", () => {
    const hub = new Hub();
    const id = hub.addClient("devA", new FakeSender());
    expect(hub.fromClient(
      "devA",
      id,
      JSON.stringify({ type: "ready", tabToken: "offline-tab" }),
    )).toBe("offline");

    const reconnected = new FakeSender();
    hub.attachUplink("devA", reconnected);
    expect(reconnected.json()).toEqual([
      { t: "clients", count: 1 },
      { t: "client-ready", clientId: id, tabToken: "offline-tab" },
    ]);
  });

  it("uplink learns which client left as well as the updated viewer count", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const c = new FakeSender();
    const id = hub.addClient("devA", c); // before uplink attaches
    hub.attachUplink("devA", up);
    expect(up.json()).toEqual([
      { t: "clients", count: 1 },
      { t: "client-ready", clientId: id },
    ]);
    up.sent = [];
    hub.removeClient("devA", id);
    expect(up.json()).toEqual([
      { t: "client-left", clientId: id },
      { t: "clients", count: 0 },
    ]);
  });

  it("snapshot to a departed client is a no-op", () => {
    const hub = new Hub();
    const up = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", new FakeSender());
    hub.removeClient("devA", id);
    expect(() => hub.fromUplink("devA", JSON.stringify({ t: "snapshot", clientId: id, msgs: [{ type: "clearMessages" }] }))).not.toThrow();
  });

  it("requires hello before accepting host traffic", () => {
    const hub = new Hub();
    const client = new FakeSender();
    hub.attachUplink("devA", new FakeSender());
    hub.addClient("devA", client);

    expect(hub.fromUplink(
      "devA",
      JSON.stringify({ t: "host", msg: { type: "messageChunk", text: "too early" } }),
    )).toEqual({ kind: "refused", reason: "hello-required" });
    expect(client.sent).toEqual([]);

    expect(hello(hub)).toEqual({ kind: "accepted" });
    expect(hub.fromUplink(
      "devA",
      JSON.stringify({ t: "host", msg: { type: "messageChunk", text: "accepted" } }),
    )).toEqual({ kind: "accepted" });
    expect(client.json()).toEqual([{ type: "messageChunk", text: "accepted" }]);
  });

  it("accepts its own protocol but refuses a peer newer than the relay", () => {
    const current = new Hub();
    current.attachUplink("devA", new FakeSender());
    expect(hello(current)).toEqual({ kind: "accepted" });

    const newer = new Hub();
    newer.attachUplink("devA", new FakeSender());
    expect(hello(newer, "devA", REMOTE_PROTO_VERSION + 1)).toEqual({
      kind: "refused",
      reason: "protocol-too-new",
      peerProto: REMOTE_PROTO_VERSION + 1,
    });
  });

  it("connectedDevices lists only devices with a live uplink", () => {
    const hub = new Hub();
    hub.attachUplink("devA", new FakeSender());
    hub.addClient("devA", new FakeSender());
    hub.addClient("devB", new FakeSender()); // no uplink
    expect(hub.connectedDevices()).toEqual([{ deviceId: "devA", clients: 1 }]);
  });

  it("a CLOSING uplink is not deliverable: fromClient returns offline and send is not called", () => {
    const hub = new Hub();
    const up = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", new FakeSender());
    up.sent = [];
    up.readyState = 2; // WebSocket.CLOSING — send() does not throw

    expect(hub.uplinkConnected("devA")).toBe(false);
    expect(hub.connectedDevices()).toEqual([]);
    expect(hub.fromClient("devA", id, JSON.stringify({ type: "send", text: "during-close" }))).toBe("offline");
    expect(up.sent).toEqual([]);

    up.readyState = 1; // WebSocket.OPEN
    expect(hub.uplinkConnected("devA")).toBe(true);
    expect(hub.fromClient("devA", id, JSON.stringify({ type: "send", text: "after-reopen" }))).toBe("routed");
    expect(up.json()).toEqual([{ t: "msg", clientId: id, msg: { type: "send", text: "after-reopen" } }]);
  });

  it("answers a transport probe to the browser and never forwards it to the uplink", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const client = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", client);
    up.sent = [];

    expect(hub.fromClient("devA", id, JSON.stringify({ type: TRANSPORT_PROBE_TYPE }))).toBe("answered");
    expect(up.sent).toEqual([]);
    expect(client.json()).toEqual([{ type: TRANSPORT_PROBE_TYPE }]);
  });

  it("answers a transport probe while the device has no uplink", () => {
    const hub = new Hub();
    const client = new FakeSender();
    const id = hub.addClient("devA", client);

    expect(hub.fromClient("devA", id, JSON.stringify({ type: TRANSPORT_PROBE_TYPE }))).toBe("answered");
    expect(client.json()).toEqual([{ type: TRANSPORT_PROBE_TYPE }]);
    expect(hub.fromClient("devA", id, JSON.stringify({ type: "send", text: "x" }))).toBe("offline");
  });

  it("answers a transport probe while the uplink is not deliverable", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const client = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", client);
    up.sent = [];
    up.readyState = 2;

    expect(hub.fromClient("devA", id, JSON.stringify({ type: TRANSPORT_PROBE_TYPE }))).toBe("answered");
    expect(up.sent).toEqual([]);
    expect(client.json()).toEqual([{ type: TRANSPORT_PROBE_TYPE }]);
  });

  it("a second client presenting an existing tab token evicts the older; client-left precedes client-ready", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const oldSender = new FakeSender();
    oldSender.outbox = ["queued-work"];
    hub.attachUplink("devA", up);
    hello(hub);
    const old = hub.addClient("devA", oldSender);
    hub.fromClient("devA", old, JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }));
    up.sent = [];

    const replacementSender = new FakeSender();
    const replacement = hub.addClient("devA", replacementSender);
    expect(hub.fromClient(
      "devA",
      replacement,
      JSON.stringify({ type: "ready", tabToken: "logical-tab-1" }),
    )).toBe("routed");

    const frames = up.json();
    const leftAt = frames.findIndex((frame) => (frame as { t?: string }).t === "client-left");
    const readyAt = frames.findIndex((frame) => (frame as { t?: string }).t === "client-ready");
    expect(leftAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(leftAt);
    expect(frames[leftAt]).toEqual({ t: "client-left", clientId: old });
    expect(frames[readyAt]).toEqual({
      t: "client-ready", clientId: replacement, tabToken: "logical-tab-1",
    });
    expect(hub.clientCount("devA")).toBe(1);
    expect(oldSender.closed).toBe(true);
    expect(oldSender.sent).toEqual([]);
    expect(oldSender.outbox).toEqual(["queued-work"]);
    expect(replacementSender.closed).toBe(false);
  });

  it("two clients with different tab tokens both stay connected", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const aSender = new FakeSender();
    const bSender = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const a = hub.addClient("devA", aSender);
    const b = hub.addClient("devA", bSender);
    hub.fromClient("devA", a, JSON.stringify({ type: "ready", tabToken: "tab-a" }));
    up.sent = [];
    hub.fromClient("devA", b, JSON.stringify({ type: "ready", tabToken: "tab-b" }));

    expect(up.json()).toEqual([
      { t: "client-ready", clientId: b, tabToken: "tab-b" },
    ]);
    expect(hub.clientCount("devA")).toBe(2);
    expect(aSender.closed).toBe(false);
    expect(bSender.closed).toBe(false);
  });

  it("the evicted client's socket is closed cleanly and its outbox is not disturbed", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const oldSender = new FakeSender();
    oldSender.outbox = ["held-send"];
    hub.attachUplink("devA", up);
    hello(hub);
    const old = hub.addClient("devA", oldSender);
    hub.fromClient("devA", old, JSON.stringify({ type: "ready", tabToken: "same-tab" }));
    const replacement = hub.addClient("devA", new FakeSender());
    hub.fromClient("devA", replacement, JSON.stringify({ type: "ready", tabToken: "same-tab" }));

    expect(oldSender.closed).toBe(true);
    expect(oldSender.readyState).toBe(3);
    expect(oldSender.sent).toEqual([]);
    expect(oldSender.outbox).toEqual(["held-send"]);
    up.sent = [];
    hub.removeClient("devA", old);
    expect(up.json().some((frame) => (frame as { t?: string }).t === "client-left")).toBe(false);
  });

  it("a reconnect with no prior client for that token behaves exactly as today", () => {
    const hub = new Hub();
    const up = new FakeSender();
    const client = new FakeSender();
    hub.attachUplink("devA", up);
    hello(hub);
    const id = hub.addClient("devA", client);
    up.sent = [];

    expect(hub.fromClient("devA", id, JSON.stringify({ type: "ready", tabToken: "fresh-tab" }))).toBe("routed");
    expect(up.json()).toEqual([
      { t: "client-ready", clientId: id, tabToken: "fresh-tab" },
    ]);
    expect(hub.clientCount("devA")).toBe(1);
    expect(client.closed).toBe(false);
    expect(up.json().some((frame) => (frame as { t?: string }).t === "client-left")).toBe(false);
  });
});
