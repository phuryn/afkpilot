import { describe, expect, it } from "vitest";
import {
  DEVICE_CLIENT_LABEL_MAX,
  hasDeviceClientInfo,
  parseDeviceClientFields,
} from "../src/device-client.js";

describe("parseDeviceClientFields", () => {
  it("accepts a full valid payload", () => {
    expect(
      parseDeviceClientFields({
        name: "DESKTOP-RHFLCK3 (Windows 11)",
        clientLabel: "VS Code extension",
        platform: "win",
        osLabel: "Windows 11",
      }),
    ).toEqual({
      ok: true,
      client: { clientLabel: "VS Code extension", platform: "win", osLabel: "Windows 11" },
    });
  });

  it("treats absent, null, and blank fields as missing — never invents values", () => {
    expect(parseDeviceClientFields({})).toEqual({ ok: true, client: {} });
    expect(parseDeviceClientFields({ clientLabel: null, platform: null, osLabel: null })).toEqual({
      ok: true,
      client: {},
    });
    expect(parseDeviceClientFields({ clientLabel: "  ", platform: "", osLabel: "\t" })).toEqual({
      ok: true,
      client: {},
    });
    expect(parseDeviceClientFields(null)).toEqual({ ok: true, client: {} });
  });

  it("accepts each field independently and trims labels", () => {
    expect(parseDeviceClientFields({ clientLabel: "  Cursor  " })).toEqual({
      ok: true,
      client: { clientLabel: "Cursor" },
    });
    expect(parseDeviceClientFields({ platform: "mac" })).toEqual({
      ok: true,
      client: { platform: "mac" },
    });
    expect(parseDeviceClientFields({ osLabel: "Ubuntu 24.04" })).toEqual({
      ok: true,
      client: { osLabel: "Ubuntu 24.04" },
    });
    expect(parseDeviceClientFields({ platform: "linux" })).toEqual({
      ok: true,
      client: { platform: "linux" },
    });
    expect(parseDeviceClientFields({ platform: "unknown" })).toEqual({
      ok: true,
      client: { platform: "unknown" },
    });
  });

  it("rejects a platform outside win|mac|linux|unknown", () => {
    expect(parseDeviceClientFields({ platform: "android" })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ platform: "WIN" })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ platform: "windows" })).toEqual({ ok: false });
  });

  it("rejects non-string values, overlong labels, and control characters", () => {
    expect(parseDeviceClientFields({ clientLabel: 12 })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ osLabel: ["Windows 11"] })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ platform: 1 })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ clientLabel: "x".repeat(DEVICE_CLIENT_LABEL_MAX + 1) })).toEqual({
      ok: false,
    });
    expect(parseDeviceClientFields({ osLabel: "Windows\n11" })).toEqual({ ok: false });
    expect(parseDeviceClientFields({ clientLabel: "VS Code\u0000extension" })).toEqual({ ok: false });
  });

  it("accepts a label at the length cap", () => {
    const label = "x".repeat(DEVICE_CLIENT_LABEL_MAX);
    expect(parseDeviceClientFields({ clientLabel: label })).toEqual({
      ok: true,
      client: { clientLabel: label },
    });
  });
});

describe("hasDeviceClientInfo", () => {
  it("is false for empty or missing client objects", () => {
    expect(hasDeviceClientInfo(undefined)).toBe(false);
    expect(hasDeviceClientInfo(null)).toBe(false);
    expect(hasDeviceClientInfo({})).toBe(false);
  });

  it("is true when any field is present", () => {
    expect(hasDeviceClientInfo({ platform: "unknown" })).toBe(true);
    expect(hasDeviceClientInfo({ clientLabel: "Desktop app" })).toBe(true);
  });
});
