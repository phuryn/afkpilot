import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeAssetVersion } from "../src/server.js";

describe("fallback deploy asset version", () => {
  it("moves when only the audio worklet bytes change", () => {
    const webRoot = mkdtempSync(join(process.cwd(), ".tmp-asset-version-"));
    const worklet = join(webRoot, "vendor", "media", "pcm-worklet.js");
    try {
      mkdirSync(join(webRoot, "vendor", "media"), { recursive: true });
      writeFileSync(join(webRoot, "chat.html"), "<script src=\"/vendor/media/chat.js\"></script>");
      writeFileSync(join(webRoot, "vendor", "media", "chat.js"), "chat");
      writeFileSync(worklet, "worklet-v1");

      const before = computeAssetVersion(webRoot, "");
      writeFileSync(worklet, "worklet-v2");
      const after = computeAssetVersion(webRoot, "");

      expect(before).toMatch(/^[0-9a-f]{12}$/);
      expect(after).toMatch(/^[0-9a-f]{12}$/);
      expect(after).not.toBe(before);
    } finally {
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
