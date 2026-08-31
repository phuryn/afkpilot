// What an empty conversation calls itself. On a cloud machine "Grok Build
// (Community)" names something the reader never installed — the machine is
// AFK Pilot's, and the agent on it is a choice they have not made yet (owner,
// 2026-08-31). Only on cloud: a linked laptop really is running the extension
// the welcome names.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

describe("the empty-conversation title", () => {
  it("still ships the extension's own name in the markup", () => {
    expect(chat).toContain('<h2 id="welcome-title">Grok Build (Community)</h2>');
  });

  it("renames it only for a cloud environment", () => {
    const at = chat.indexOf('welcomeTitle.textContent = "AFK Pilot Cloud"');
    expect(at).toBeGreaterThan(-1);
    // The rename is inside the cloud branch, and reads the element by id
    // rather than guessing at a heading.
    const before = chat.slice(0, at);
    const guard = before.lastIndexOf("if (isCloudDevice) {");
    expect(guard).toBeGreaterThan(-1);
    expect(before.slice(guard)).toContain('document.getElementById("welcome-title")');
    // Nothing between the guard and the rename closes that branch.
    expect(before.slice(guard).split("\n").filter((line) => line === "  }")).toHaveLength(0);
  });
});
