// Copy the chat UI out of the extension repo into web/vendor/ so the relay can
// serve it. The extension repo stays the single source of truth for the UI —
// re-run this after pulling it. Usage:
//   node scripts/sync-ui.mjs [path-to-grok-build-vscode] [vendor-output]
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPath,
  UI_VENDOR_COPIES,
  UI_VENDOR_HASH_MANIFEST,
  UI_VENDOR_HASH_MANIFEST_VERSION,
} from "./ui-vendor-manifest.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extRoot = resolve(process.argv[2] ?? join(repoRoot, "..", "grok-build-vscode"));
const vendor = resolve(process.argv[3] ?? join(repoRoot, "web", "vendor"));

if (!existsSync(join(extRoot, "media", "chat.js"))) {
  console.error(`Extension repo not found at ${extRoot} — pass its path: node scripts/sync-ui.mjs <path>`);
  process.exit(1);
}

for (const [from, to] of UI_VENDOR_COPIES) {
  const src = join(extRoot, from);
  const dest = join(vendor, to);
  mkdirSync(dirname(dest), { recursive: true });
  // A directory entry is MIRRORED, not merged. `cpSync` writes over what it
  // finds and leaves everything else in place, so a file deleted upstream
  // would survive here forever — and because `check:vendor` hashes the whole
  // tree, it would report stale on every run with nothing this script could
  // do about it. Clearing the destination first is what makes a deletion
  // propagate. (Found when a connector logo was removed upstream.)
  if (statSync(src).isDirectory()) rmSync(dest, { recursive: true, force: true });
  // `recursive` so a directory entry (the icon set) copies as a tree; harmless
  // for the file entries, which are the rest of the list.
  cpSync(src, dest, { recursive: true });
  console.log(`synced ${from}`);
}

const revisionResult = spawnSync("git", ["-C", extRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
const sourceRevision = revisionResult.status === 0 ? revisionResult.stdout.trim() : null;
const statusResult = sourceRevision === null
  ? null
  : spawnSync(
      "git",
      ["-C", extRoot, "status", "--porcelain", "--", ...UI_VENDOR_COPIES.map(([from]) => from)],
      { encoding: "utf8" },
    );
const sourceFilesMatchRevision =
  statusResult?.status === 0 ? statusResult.stdout.trim().length === 0 : null;

// The extension version this UI was cut from. It is what the browser client
// reports as its own version, because that is literally what it is running —
// the relay's package version says nothing about the UI, and the deploy hash is
// not a number anyone can compare against the app on their desk.
let sourceVersion = null;
try {
  sourceVersion =
    JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8")).version ?? null;
} catch {
  /* leave null — the page falls back to the deploy hash */
}

const manifest = {
  version: UI_VENDOR_HASH_MANIFEST_VERSION,
  source: {
    repository: "grok-build-vscode",
    revision: sourceRevision,
    appVersion: sourceVersion,
    filesMatchRevision: sourceFilesMatchRevision,
  },
  artifacts: UI_VENDOR_COPIES.map(([source, destination]) => ({
    source,
    destination,
    sha256: hashPath(join(vendor, destination)),
  })),
};
writeFileSync(
  join(vendor, UI_VENDOR_HASH_MANIFEST),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`wrote ${UI_VENDOR_HASH_MANIFEST}`);
console.log(`UI synced from ${extRoot}`);
