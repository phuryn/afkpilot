import { describe, expect, it } from "vitest";
import "../web/device-display.js";

const display = (globalThis as unknown as {
  deviceDisplay: {
    parseLegacyDeviceName: (name: string) => {
      displayName: string;
      parenthetical: string | null;
      platform: string;
    };
    resolveDeviceDisplay: (device: Record<string, unknown>) => {
      displayName: string;
      parenthetical: string | null;
      platform: string;
    };
    osIconSvg: (platform: string) => string;
  };
}).deviceDisplay;

describe("parseLegacyDeviceName", () => {
  it("splits a legacy HOST (Windows 11) name and picks the win icon", () => {
    expect(display.parseLegacyDeviceName("DESKTOP-RHFLCK3 (Windows 11)")).toEqual({
      displayName: "DESKTOP-RHFLCK3",
      parenthetical: "Windows 11",
      platform: "win",
    });
  });

  it("derives mac and linux from loose OS keywords", () => {
    expect(display.parseLegacyDeviceName("paws-mac (macOS Sequoia)").platform).toBe("mac");
    expect(display.parseLegacyDeviceName("devbox (Ubuntu Linux)").platform).toBe("linux");
  });

  it("treats a name with no trailing parens as generic", () => {
    expect(display.parseLegacyDeviceName("Just a laptop")).toEqual({
      displayName: "Just a laptop",
      parenthetical: null,
      platform: "unknown",
    });
  });

  it("does not treat a mid-name parenthetical as the OS suffix", () => {
    expect(display.parseLegacyDeviceName("My (work) laptop")).toEqual({
      displayName: "My (work) laptop",
      parenthetical: null,
      platform: "unknown",
    });
  });
});

describe("resolveDeviceDisplay", () => {
  it("prefers stored client fields and still strips a legacy name suffix", () => {
    expect(
      display.resolveDeviceDisplay({
        name: "DESKTOP-RHFLCK3 (Windows 11)",
        clientLabel: "VS Code extension",
        platform: "win",
        osLabel: "Windows 11",
      }),
    ).toEqual({
      displayName: "DESKTOP-RHFLCK3",
      parenthetical: "VS Code extension, Windows 11",
      platform: "win",
    });
  });

  it("falls back to parsing the legacy name when stored fields are null", () => {
    expect(
      display.resolveDeviceDisplay({
        name: "DESKTOP-RHFLCK3 (Windows 11)",
        clientLabel: null,
        platform: null,
        osLabel: null,
      }),
    ).toEqual({
      displayName: "DESKTOP-RHFLCK3",
      parenthetical: "Windows 11",
      platform: "win",
    });
  });

  it("uses a generic icon and the raw name when nothing is parseable", () => {
    expect(display.resolveDeviceDisplay({ name: "mystery-box" })).toEqual({
      displayName: "mystery-box",
      parenthetical: null,
      platform: "unknown",
    });
  });

  it("fills each MISSING field from the legacy parenthetical (partial metadata)", () => {
    // {platform only}: the legacy "(Windows 11)" still supplies the visible OS.
    expect(
      display.resolveDeviceDisplay({ name: "HOST (Windows 11)", platform: "win" }),
    ).toEqual({
      displayName: "HOST",
      parenthetical: "Windows 11",
      platform: "win",
    });
    // {clientLabel only}: label leads, legacy OS half is kept beside it.
    expect(
      display.resolveDeviceDisplay({ name: "HOST (Windows 11)", clientLabel: "Cursor extension" }),
    ).toEqual({
      displayName: "HOST",
      parenthetical: "Cursor extension, Windows 11",
      platform: "win",
    });
  });

  it("keeps an explicit unknown platform instead of re-deriving it", () => {
    expect(
      display.resolveDeviceDisplay({
        name: "box",
        platform: "unknown",
        osLabel: "Windows 11",
      }),
    ).toEqual({
      displayName: "box",
      parenthetical: "Windows 11",
      platform: "unknown",
    });
  });
});

describe("osIconSvg", () => {
  it("returns a distinct currentColor silhouette per platform", () => {
    const win = display.osIconSvg("win");
    const mac = display.osIconSvg("mac");
    const linux = display.osIconSvg("linux");
    const generic = display.osIconSvg("unknown");
    expect(win).toContain("<svg");
    expect(mac).toContain("<svg");
    expect(linux).toContain("<svg");
    expect(generic).toContain("<svg");
    expect(new Set([win, mac, linux, generic]).size).toBe(4);
    // The owner's chosen marks: the four-pane flag as ONE filled path, the
    // Apple silhouette under its combined source translate.
    expect((win.match(/<path /g) || []).length).toBe(1);
    expect(win).toContain('fill="currentColor"');
    expect(win).not.toContain("<rect");
    expect(mac).toContain('transform="translate(-46 -7279)"');
    expect(mac).toContain('fill="currentColor"');
    expect(linux).toContain('fill="currentColor"');
    expect(linux).toContain('fill-rule="evenodd"');
    expect(generic).toContain("<rect");
    expect(generic).toContain('stroke="currentColor"');
  });
});
