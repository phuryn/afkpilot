// Routing hub — pure over an injected Sender, so tests drive it with fakes.
//
// One uplink (the extension) per device, N browser clients per device. The hub
// ferries: uplink `host` frames -> every client (raw HostMsg JSON), while
// `host-to` targets a listed subset; a client's `ready` -> `client-ready` to
// the uplink (which answers with a `snapshot` frame routed back to just that
// client); any other client message -> `msg` frame to the uplink. It never
// interprets protocol payloads beyond `type`.

import {
  clientLeftFrame,
  clientReadyFrame,
  clientsFrame,
  msgFrame,
  parseClientMsg,
  parseUplinkFrame,
  REMOTE_PROTO_VERSION,
  type ProtocolMsg,
} from "./frames.js";

export interface Sender {
  send(data: string): void;
}

interface DeviceHub {
  uplink?: Sender;
  uplinkProto?: number;
  clients: Map<string, { sender: Sender; tabToken?: string }>;
}

export type UplinkResult =
  | { kind: "accepted" | "dropped" }
  | { kind: "refused"; reason: "hello-required" }
  | { kind: "refused"; reason: "protocol-too-new"; peerProto: number };

export class Hub {
  private devices = new Map<string, DeviceHub>();
  private clientSeq = 0;

  constructor(private readonly log: (line: string) => void = () => {}) {}

  private device(deviceId: string): DeviceHub {
    let d = this.devices.get(deviceId);
    if (!d) {
      d = { clients: new Map() };
      this.devices.set(deviceId, d);
    }
    return d;
  }

  private safeSend(s: Sender | undefined, data: string): void {
    try {
      s?.send(data);
    } catch {
      /* peer mid-teardown; its close handler detaches it */
    }
  }

  private notifyClientCount(d: DeviceHub): void {
    this.safeSend(d.uplink, JSON.stringify(clientsFrame(d.clients.size)));
  }

  // ---------- uplink (extension) ----------

  /** Returns false when the device already has a live uplink (second VS Code
   *  window with the same token) — caller should refuse the new socket. */
  attachUplink(deviceId: string, sender: Sender): boolean {
    const d = this.device(deviceId);
    if (d.uplink) return false;
    d.uplink = sender;
    d.uplinkProto = undefined;
    this.notifyClientCount(d);
    // A reconnecting extension must rebuild every live browser's snapshot.
    // Drive the existing ready -> snapshot choreography for the clients that
    // survived the outage; clients that left meanwhile are no longer present.
    for (const [clientId, client] of d.clients) {
      this.safeSend(d.uplink, JSON.stringify(clientReadyFrame(clientId, client.tabToken)));
    }
    return true;
  }

  detachUplink(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) {
      d.uplink = undefined;
      d.uplinkProto = undefined;
    }
  }

  uplinkConnected(deviceId: string): boolean {
    return !!this.devices.get(deviceId)?.uplink;
  }

  /** An extension->relay frame arrived. */
  fromUplink(deviceId: string, raw: string): UplinkResult {
    const frame = parseUplinkFrame(raw);
    if (!frame) return { kind: "dropped" };
    const d = this.device(deviceId);
    if (frame.t !== "hello" && d.uplinkProto === undefined) {
      return { kind: "refused", reason: "hello-required" };
    }
    switch (frame.t) {
      case "hello":
        // Protocol evolution is additive, and old installed extensions must
        // continue to work with a newer relay. The unsafe direction is a peer
        // using a protocol this relay does not yet understand.
        if (frame.proto > REMOTE_PROTO_VERSION) {
          return { kind: "refused", reason: "protocol-too-new", peerProto: frame.proto };
        }
        d.uplinkProto = frame.proto;
        this.log(`[hub] ${deviceId} hello (proto ${frame.proto}${frame.device?.name ? `, ${frame.device.name}` : ""})`);
        return { kind: "accepted" };
      case "host": {
        const data = JSON.stringify(frame.msg);
        for (const c of d.clients.values()) this.safeSend(c.sender, data);
        return { kind: "accepted" };
      }
      case "host-to": {
        const data = JSON.stringify(frame.msg);
        for (const clientId of frame.clientIds) this.safeSend(d.clients.get(clientId)?.sender, data);
        return { kind: "accepted" };
      }
      case "snapshot": {
        const client = d.clients.get(frame.clientId);
        if (!client) return { kind: "accepted" }; // left before the snapshot landed
        for (const m of frame.msgs) this.safeSend(client.sender, JSON.stringify(m));
        return { kind: "accepted" };
      }
    }
  }

  // ---------- browser clients ----------

  addClient(deviceId: string, sender: Sender): string {
    const d = this.device(deviceId);
    const clientId = `c${++this.clientSeq}`;
    d.clients.set(clientId, { sender });
    this.notifyClientCount(d);
    return clientId;
  }

  removeClient(deviceId: string, clientId: string): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    const removed = d.clients.delete(clientId);
    if (removed) this.safeSend(d.uplink, JSON.stringify(clientLeftFrame(clientId)));
    this.notifyClientCount(d);
  }

  /** A browser->relay message arrived. `ready` becomes a routed client-ready
   *  (the uplink answers with that client's snapshot); everything else wraps
   *  into a `msg` frame — the EXTENSION owns the capability gate, the relay
   *  stays policy-free. Returns "offline" when no uplink is connected so the
   *  server can tell the browser. */
  fromClient(deviceId: string, clientId: string, raw: string): "routed" | "dropped" | "offline" {
    const msg: ProtocolMsg | null = parseClientMsg(raw);
    if (!msg) return "dropped";
    const d = this.device(deviceId);
    if (msg.type === "ready") {
      const client = d.clients.get(clientId);
      const tabToken = typeof msg.tabToken === "string" ? msg.tabToken : undefined;
      if (client) client.tabToken = tabToken;
      if (!d.uplink) return "offline";
      this.safeSend(
        d.uplink,
        JSON.stringify(clientReadyFrame(clientId, tabToken)),
      );
      return "routed";
    }
    if (!d.uplink) return "offline";
    this.safeSend(d.uplink, JSON.stringify(msgFrame(clientId, msg)));
    return "routed";
  }

  clientCount(deviceId: string): number {
    return this.devices.get(deviceId)?.clients.size ?? 0;
  }

  /** Devices with a live uplink — what the picker page lists. */
  connectedDevices(): { deviceId: string; clients: number }[] {
    const out: { deviceId: string; clients: number }[] = [];
    for (const [deviceId, d] of this.devices) {
      if (d.uplink) out.push({ deviceId, clients: d.clients.size });
    }
    return out;
  }
}
