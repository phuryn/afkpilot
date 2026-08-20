import { describe, it, expect } from "vitest";
import {
  parseUplinkFrame,
  parseClientMsg,
  clientReadyFrame,
  clientLeftFrame,
  msgFrame,
  clientsFrame,
  TRANSPORT_PROBE_TYPE,
  isTransportProbe,
  transportProbeReply,
} from "../src/frames.js";

describe("parseUplinkFrame", () => {
  it("round-trips hello/host/host-to/snapshot", () => {
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, device: { name: "box" } }))).toEqual({
      t: "hello", proto: 1, device: { name: "box" },
    });
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1 }))).toEqual({ t: "hello", proto: 1 });
    expect(
      parseUplinkFrame(
        JSON.stringify({
          t: "hello",
          proto: 1,
          device: { name: "box" },
          client: { clientLabel: "VS Code extension", platform: "win", osLabel: "Windows 11" },
        }),
      ),
    ).toEqual({
      t: "hello",
      proto: 1,
      device: { name: "box" },
      client: { clientLabel: "VS Code extension", platform: "win", osLabel: "Windows 11" },
    });
    expect(parseUplinkFrame(JSON.stringify({ t: "host", msg: { type: "messageChunk", text: "x" } }))).toEqual({
      t: "host", msg: { type: "messageChunk", text: "x" },
    });
    expect(parseUplinkFrame(JSON.stringify({
      t: "host-to", clientIds: ["c1", "c3"], msg: { type: "messageChunk", text: "group" },
    }))).toEqual({
      t: "host-to", clientIds: ["c1", "c3"], msg: { type: "messageChunk", text: "group" },
    });
    expect(parseUplinkFrame(JSON.stringify({ t: "snapshot", clientId: "c1", msgs: [{ type: "clearMessages" }] }))).toEqual({
      t: "snapshot", clientId: "c1", msgs: [{ type: "clearMessages" }],
    });
  });

  it("rejects malformed frames without throwing", () => {
    expect(parseUplinkFrame("junk")).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "hello" }))).toBeNull(); // no proto
    expect(parseUplinkFrame(JSON.stringify({ t: "host", msg: { text: "x" } }))).toBeNull(); // msg w/o type
    expect(parseUplinkFrame(JSON.stringify({ t: "host-to", clientIds: "c1", msg: { type: "clearMessages" } }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "host-to", clientIds: ["c1", 2], msg: { type: "clearMessages" } }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "host-to", clientIds: ["c1"], msg: {} }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "snapshot", clientId: "c1", msgs: [{}] }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "snapshot", msgs: [] }))).toBeNull(); // no clientId
    expect(parseUplinkFrame(JSON.stringify({ t: "other" }))).toBeNull();
  });

  it("reuses device-client validation for optional hello.client", () => {
    // Same rules as POST /api/link/start: valid fields attach, junk is refused
    // (not coerced), and a hello with no client still parses.
    expect(
      parseUplinkFrame(
        JSON.stringify({ t: "hello", proto: 1, client: { clientLabel: "  Cursor  ", platform: "mac" } }),
      ),
    ).toEqual({
      t: "hello",
      proto: 1,
      client: { clientLabel: "Cursor", platform: "mac" },
    });
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, client: {} }))).toEqual({
      t: "hello",
      proto: 1,
    });
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, client: { platform: "android" } }))).toBeNull();
    expect(
      parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, client: { clientLabel: "x".repeat(65) } })),
    ).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, client: { osLabel: "Windows\n11" } }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ t: "hello", proto: 1, client: "VS Code" }))).toBeNull();
  });
});

describe("parseClientMsg", () => {
  it("accepts any object with a string type, rejects the rest", () => {
    expect(parseClientMsg(JSON.stringify({ type: "send", text: "hi" }))).toEqual({ type: "send", text: "hi" });
    expect(parseClientMsg(JSON.stringify({
      type: "send", text: "queued", queuedSendId: "queued-send-1",
    }))).toEqual({
      type: "send", text: "queued", queuedSendId: "queued-send-1",
    });
    expect(parseClientMsg(JSON.stringify({ text: "hi" }))).toBeNull();
    expect(parseClientMsg("nope")).toBeNull();
    expect(parseClientMsg("[1]")).toBeNull();
  });

  it("accepts the client-relay transport probe without treating it as host traffic", () => {
    const probe = parseClientMsg(JSON.stringify({ type: TRANSPORT_PROBE_TYPE }));
    expect(probe).toEqual({ type: TRANSPORT_PROBE_TYPE });
    expect(isTransportProbe(probe!)).toBe(true);
    expect(isTransportProbe({ type: "send" })).toBe(false);
    expect(transportProbeReply()).toEqual({ type: TRANSPORT_PROBE_TYPE });
    expect(parseUplinkFrame(JSON.stringify({ t: TRANSPORT_PROBE_TYPE }))).toBeNull();
  });
});

describe("relay frame builders", () => {
  it("build the shapes the extension's parser expects", () => {
    expect(clientReadyFrame("c9")).toEqual({ t: "client-ready", clientId: "c9" });
    expect(clientReadyFrame("c9", "tab-stable-1")).toEqual({
      t: "client-ready", clientId: "c9", tabToken: "tab-stable-1",
    });
    expect(clientLeftFrame("c9")).toEqual({ t: "client-left", clientId: "c9" });
    expect(msgFrame("c9", { type: "cancel" })).toEqual({ t: "msg", clientId: "c9", msg: { type: "cancel" } });
    expect(clientsFrame(3)).toEqual({ t: "clients", count: 3 });
  });
});
