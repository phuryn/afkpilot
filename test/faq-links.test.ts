import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

describe("FAQ report links", () => {
  it("offers explicit bug and feature issue templates", () => {
    expect(html).toContain(
      'href="https://github.com/phuryn/grok-build-vscode/issues/new?labels=bug"',
    );
    expect(html).toContain(
      'href="https://github.com/phuryn/grok-build-vscode/issues/new?labels=enhancement"',
    );
    expect(html).toMatch(/report a bug/i);
    expect(html).toMatch(/request a feature/i);
  });
});
