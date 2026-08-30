// A cloud machine being BUILT is progress, not a fault. The page used to
// announce it through the error channel, so an ordinary minute of waiting
// arrived in red (owner, 2026-08-31).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

describe("the cloud first-boot message", () => {
  it("uses the notice channel while booting and the error channel for real failures", () => {
    expect(chat).toContain('type: stillBooting ? "hostNotice" : "error"');
    // The escalation after a boot that never finishes stays an error.
    expect(chat).toMatch(/still hasn't come up[\s\S]{0,200}?/);
    const escalation = chat.slice(chat.indexOf("firstBootErrorTimer = setTimeout"));
    expect(escalation.slice(0, 400)).toContain('type: "error"');
  });

  it("renders as progress: a spinner in the notice's own blue, and reduced-motion honoured", () => {
    expect(chat).toContain("markBootingNotice");
    expect(chat).toContain(".plan-notice.cloud-booting");
    expect(chat).toContain("cloud-booting-spin");
    expect(chat).toMatch(/prefers-reduced-motion[\s\S]{0,220}cloud-booting/);
  });
});
