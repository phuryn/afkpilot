import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { UI_VENDOR_COPIES } from "../scripts/ui-vendor-manifest.mjs";

describe("UI vendor hash gate", () => {
  it("verifies the real committed vendor tree without the sibling checkout", () => {
    const checked = execFileSync(
      process.execPath,
      ["scripts/check-ui-vendor.mjs", "--vendor-only"],
      { encoding: "utf8" },
    );
    expect(checked).toContain("committed artifacts match their manifest");
  });

  it("distinguishes manifest tampering from stale sibling source", () => {
    // Under the OS temp dir, not the repo. The `finally` below removes it, but
    // a run that is KILLED never reaches that — and a scratch tree left inside
    // the working copy is one `git add -A` away from being committed, which is
    // how it once was.
    const root = mkdtempSync(join(tmpdir(), "grok-vendor-check-"));
    const extension = join(root, "extension");
    const vendor = join(root, "vendor");
    try {
      for (const [relative] of UI_VENDOR_COPIES) {
        const source = join(extension, relative);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, `fixture:${relative}`);
      }

      execFileSync(process.execPath, ["scripts/sync-ui.mjs", extension, vendor]);
      execFileSync(process.execPath, ["scripts/check-ui-vendor.mjs", "--vendor-only", vendor]);
      writeFileSync(join(vendor, "media", "chat.js"), "deliberately stale");

      const tampered = spawnSync(
        process.execPath,
        ["scripts/check-ui-vendor.mjs", "--vendor-only", vendor],
        { encoding: "utf8" },
      );
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain("committed vendor does not match its manifest");
      expect(tampered.stderr).toContain("media/chat.js");

      execFileSync(process.execPath, ["scripts/sync-ui.mjs", extension, vendor]);
      writeFileSync(join(extension, "media", "chat.js"), "new sibling source");
      const stale = spawnSync(
        process.execPath,
        ["scripts/check-ui-vendor.mjs", extension, vendor],
        { encoding: "utf8" },
      );
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("media/chat.js");
      expect(stale.stderr).toContain("stale vendor; run npm run sync-ui");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
