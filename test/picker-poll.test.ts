import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

const pollSrc = html.slice(
  html.indexOf("function stopDevicePoll()"),
  html.indexOf("function startPicker()"),
);

describe("device-picker poll is visibility-aware", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the interval while hidden and does not leave a dangling setInterval", () => {
    expect(html).toContain("function stopDevicePoll()");
    expect(html).toContain("clearInterval(timer)");
    expect(pollSrc).toContain('document.visibilityState === "hidden"');
    expect(html).toContain("document.addEventListener(\"visibilitychange\", onPickerVisibility)");
    expect(html).toContain("pollEnabled = true");
  });

  it("refreshes immediately on return, then resumes the 3s interval", () => {
    const visSrc = html.slice(
      html.indexOf("function onPickerVisibility()"),
      html.indexOf("function startPicker()"),
    );
    expect(visSrc).toContain("refresh()");
    expect(visSrc).toContain("startDevicePoll()");
    expect(visSrc.indexOf("refresh()")).toBeLessThan(visSrc.indexOf("startDevicePoll()"));
    expect(html).toContain("setInterval(refresh, 3000)");
  });

  it("does not tick while hidden, and ticks again after becoming visible", () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const stats = { refreshes: 0 };
    const runtime = new Function(
      "document",
      "stats",
      `
        var timer = null;
        var pollEnabled = true;
        function refresh() { stats.refreshes += 1; }
        ${pollSrc}
        return { startDevicePoll, stopDevicePoll, onPickerVisibility };
      `,
    )({
      get visibilityState() { return visibility; },
    }, stats) as {
      startDevicePoll: () => void;
      stopDevicePoll: () => void;
      onPickerVisibility: () => void;
    };

    runtime.startDevicePoll();
    vi.advanceTimersByTime(9_000);
    expect(stats.refreshes).toBe(3);

    visibility = "hidden";
    runtime.onPickerVisibility();
    vi.advanceTimersByTime(9_000);
    expect(stats.refreshes).toBe(3);

    visibility = "visible";
    runtime.onPickerVisibility();
    expect(stats.refreshes).toBe(4);
    vi.advanceTimersByTime(3_000);
    expect(stats.refreshes).toBe(5);
  });
});
