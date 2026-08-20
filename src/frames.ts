import { hasDeviceClientInfo, parseDeviceClientFields, type DeviceClientInfo } from "./device-client.js";

// Relay-side mirror of the extension's src/remote-frames.ts wire contract.
// The two copies are deliberately tiny so they can't drift far; bump
// REMOTE_PROTO_VERSION in BOTH repos on any incompatible change.
//
// Legs:
//   extension -> relay : UplinkFrame  (hello / host / host-to / snapshot)
//   relay -> extension : RelayFrame   (client-ready / client-left / msg / clients)
//   browser  <-> relay : raw HostMsg / WebviewMsg JSON (the webview protocol
//                        itself — the relay only inspects `type`), plus a
//                        transport probe the relay answers and never forwards.

export const REMOTE_PROTO_VERSION = 1;

/** The relay treats protocol messages as opaque except for the discriminant. */
export interface ProtocolMsg {
  type: string;
  [k: string]: unknown;
}

export type UplinkFrame =
  | { t: "hello"; proto: number; device?: { name?: string }; client?: DeviceClientInfo }
  | { t: "host"; msg: ProtocolMsg }
  | { t: "host-to"; clientIds: string[]; msg: ProtocolMsg }
  | { t: "snapshot"; clientId: string; msgs: ProtocolMsg[] };

export type RelayFrame =
  | { t: "client-ready"; clientId: string; tabToken?: string }
  | { t: "client-left"; clientId: string }
  | { t: "msg"; clientId: string; msg: ProtocolMsg }
  | { t: "clients"; count: number };

const isProtocolMsg = (v: unknown): v is ProtocolMsg =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Parse + shape-validate an extension->relay frame. null = drop (never throw). */
export function parseUplinkFrame(raw: string): UplinkFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const f = obj as Record<string, unknown>;
  switch (f.t) {
    case "hello": {
      if (typeof f.proto !== "number") return null;
      const name = (f.device as { name?: unknown } | undefined)?.name;
      let client: DeviceClientInfo | undefined;
      if (f.client !== undefined && f.client !== null) {
        if (typeof f.client !== "object" || Array.isArray(f.client)) return null;
        const parsed = parseDeviceClientFields(f.client as Record<string, unknown>);
        if (!parsed.ok) return null;
        if (hasDeviceClientInfo(parsed.client)) client = parsed.client;
      }
      return {
        t: "hello",
        proto: f.proto,
        ...(typeof name === "string" ? { device: { name } } : {}),
        ...(client ? { client } : {}),
      };
    }
    case "host":
      return isProtocolMsg(f.msg) ? { t: "host", msg: f.msg } : null;
    case "host-to":
      if (!Array.isArray(f.clientIds) || !f.clientIds.every((clientId) => typeof clientId === "string")) return null;
      return isProtocolMsg(f.msg) ? { t: "host-to", clientIds: f.clientIds as string[], msg: f.msg } : null;
    case "snapshot":
      if (typeof f.clientId !== "string" || !Array.isArray(f.msgs)) return null;
      return f.msgs.every(isProtocolMsg) ? { t: "snapshot", clientId: f.clientId, msgs: f.msgs as ProtocolMsg[] } : null;
    default:
      return null;
  }
}

/** Parse a browser->relay message (raw webview protocol). null = drop. */
export function parseClientMsg(raw: string): ProtocolMsg | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  return isProtocolMsg(obj) ? obj : null;
}

/**
 * Browser <-> relay transport liveness. The relay answers this itself and
 * never forwards it to the extension — not a host-protocol type, so
 * REMOTE_PROTO_VERSION does not move.
 */
export const TRANSPORT_PROBE_TYPE = "transportProbe";

export const isTransportProbe = (msg: ProtocolMsg): boolean => msg.type === TRANSPORT_PROBE_TYPE;

export const transportProbeReply = (): ProtocolMsg => ({ type: TRANSPORT_PROBE_TYPE });

export const clientReadyFrame = (clientId: string, tabToken?: string): RelayFrame => ({
  t: "client-ready",
  clientId,
  ...(typeof tabToken === "string" ? { tabToken } : {}),
});
export const clientLeftFrame = (clientId: string): RelayFrame => ({ t: "client-left", clientId });
export const msgFrame = (clientId: string, msg: ProtocolMsg): RelayFrame => ({ t: "msg", clientId, msg });
export const clientsFrame = (count: number): RelayFrame => ({ t: "clients", count });
