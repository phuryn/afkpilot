// Routing hub — pure over an injected Sender, so tests drive it with fakes.
//
// One uplink (the extension) per device, N browser clients per device. The hub
// ferries: uplink `host` frames -> every client (raw HostMsg JSON), while
// `host-to` targets a listed subset; a client's `ready` -> `client-ready` to
// the uplink (which answers with a `snapshot` frame routed back to just that
// client); a transport probe -> a reply to the same browser (never the host);
// any other client message -> `msg` frame to the uplink. It never interprets
// protocol payloads beyond `type`.

import {
  clientLeftFrame,
  clientReadyFrame,
  clientsFrame,
  isTransportProbe,
  msgFrame,
  parseClientMsg,
  parseUplinkFrame,
  REMOTE_PROTO_VERSION,
  transportProbeReply,
  type ProtocolMsg,
} from "./frames.js";

export interface Sender {
  send(data: string): void;
  /** Present on a real WebSocket. Absent on test fakes, which are treated
   *  as deliverable. Same numeric values as the WebSocket spec. */
  readonly readyState?: number;
  /** Present on a real WebSocket. The hub calls this when a later client
   *  presents the same tab token, so the predecessor stops sending. */
  close?(): void;
}

/** WebSocket.OPEN. Hub stays free of a `ws` import. */
const WS_OPEN = 1;

function senderDeliverable(s: Sender | undefined): boolean {
  if (!s) return false;
  // CONNECTING / CLOSING / CLOSED all fail this. ws.send() while CLOSING
  // does not throw and does not deliver — treating that as "connected"
  // charges the user, reports routed, and never bounces Device offline.
  return s.readyState === undefined || s.readyState === WS_OPEN;
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

  private closeSender(s: Sender): void {
    try {
      s.close?.();
    } catch {
      /* already closing */
    }
  }

  /**
   * One tab token is one client. A reconnecting socket presenting a token
   * another client already holds is that same tab, not a rival: evict the
   * predecessor so its `client-left` reaches the uplink before the
   * newcomer's `client-ready`. The host then sees the departure before the
   * arrival and has no conflict to refuse. Match is the exact token only —
   * never device or address, which would let one tab kill another
   * legitimate one.
   *
   * Returns the evicted senders so the caller can close them AFTER the
   * successor's `client-ready` is written. Closing first can fire the
   * socket's close handler, and that path must not be what orders the
   * uplink frames.
   */
  private evictClientsWithTabToken(d: DeviceHub, keepClientId: string, tabToken: string): Sender[] {
    const evicted: Sender[] = [];
    for (const [id, client] of [...d.clients]) {
      if (id === keepClientId) continue;
      if (client.tabToken !== tabToken) continue;
      d.clients.delete(id);
      this.safeSend(d.uplink, JSON.stringify(clientLeftFrame(id)));
      evicted.push(client.sender);
    }
    return evicted;
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
    return senderDeliverable(this.devices.get(deviceId)?.uplink);
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
   *  (the uplink answers with that client's snapshot); a transport probe is
   *  answered to that browser and never forwarded (liveness of this socket,
   *  including with no uplink); everything else wraps into a `msg` frame —
   *  the EXTENSION owns the capability gate, the relay stays policy-free.
   *  Returns "offline" when no uplink is deliverable (missing, or a WebSocket
   *  that is not OPEN) so the server can tell the browser. */
  fromClient(deviceId: string, clientId: string, raw: string): "routed" | "dropped" | "offline" | "answered" {
    const msg: ProtocolMsg | null = parseClientMsg(raw);
    if (!msg) return "dropped";
    const d = this.device(deviceId);
    if (isTransportProbe(msg)) {
      const client = d.clients.get(clientId);
      if (!client) return "dropped";
      this.safeSend(client.sender, JSON.stringify(transportProbeReply()));
      return "answered";
    }
    if (msg.type === "ready") {
      const client = d.clients.get(clientId);
      const tabToken = typeof msg.tabToken === "string" ? msg.tabToken : undefined;
      if (client) client.tabToken = tabToken;
      const evicted = tabToken ? this.evictClientsWithTabToken(d, clientId, tabToken) : [];
      if (!senderDeliverable(d.uplink)) {
        for (const sender of evicted) this.closeSender(sender);
        return "offline";
      }
      this.safeSend(
        d.uplink,
        JSON.stringify(clientReadyFrame(clientId, tabToken)),
      );
      if (evicted.length) this.notifyClientCount(d);
      for (const sender of evicted) this.closeSender(sender);
      return "routed";
    }
    if (!senderDeliverable(d.uplink)) return "offline";
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
      if (senderDeliverable(d.uplink)) out.push({ deviceId, clients: d.clients.size });
    }
    return out;
  }
}
