import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const start = html.indexOf("function devicesFetchKind(status)");
const end = html.indexOf("function setPickerSurface", start);
const devicesFetchKind = new Function(
  `${html.slice(start, end)}; return devicesFetchKind;`,
)() as (status: number) => "session" | "unreachable";

describe("picker must not render an auth failure as no devices", () => {
  it("treats 401/403 as a session problem", () => {
    expect(devicesFetchKind(401)).toBe("session");
    expect(devicesFetchKind(403)).toBe("session");
  });

  it("treats other non-OK statuses as a transient reachability problem", () => {
    expect(devicesFetchKind(500)).toBe("unreachable");
    expect(devicesFetchKind(502)).toBe("unreachable");
    expect(devicesFetchKind(404)).toBe("unreachable");
  });
});
