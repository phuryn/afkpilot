// Authenticate committed web/vendor artifacts against their generated hash
// manifest. When the sibling extension checkout is available, also ensure the
// committed artifacts are current with its source files.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPath,
  UI_VENDOR_COPIES,
  UI_VENDOR_HASH_MANIFEST,
  UI_VENDOR_HASH_MANIFEST_VERSION,
} from "./ui-vendor-manifest.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const vendorOnly = args[0] === "--vendor-only";
if (vendorOnly) args.shift();

const explicitExtensionRoot = vendorOnly ? undefined : args[0];
const extensionRoot = resolve(explicitExtensionRoot ?? join(repoRoot, "..", "grok-build-vscode"));
const vendorRoot = resolve((vendorOnly ? args[0] : args[1]) ?? join(repoRoot, "web", "vendor"));
const manifestPath = resolve(
  (vendorOnly ? args[1] : args[2]) ?? join(vendorRoot, UI_VENDOR_HASH_MANIFEST),
);
const manifestProblems = [];
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  manifestProblems.push(
    existsSync(manifestPath)
      ? `${UI_VENDOR_HASH_MANIFEST} is not valid JSON`
      : `${UI_VENDOR_HASH_MANIFEST} is missing`,
  );
}

if (manifest) {
  if (manifest.version !== UI_VENDOR_HASH_MANIFEST_VERSION) {
    manifestProblems.push(
      `${UI_VENDOR_HASH_MANIFEST} has unsupported version ${String(manifest.version)}`,
    );
  }
  if (
    manifest.source?.repository !== "grok-build-vscode"
    || !Object.hasOwn(manifest.source, "revision")
    || (typeof manifest.source.revision !== "string" && manifest.source.revision !== null)
    || (
      typeof manifest.source.filesMatchRevision !== "boolean"
      && manifest.source.filesMatchRevision !== null
    )
  ) {
    manifestProblems.push(`${UI_VENDOR_HASH_MANIFEST} has missing or invalid source metadata`);
  }
  if (!Array.isArray(manifest.artifacts)) {
    manifestProblems.push(`${UI_VENDOR_HASH_MANIFEST} has no artifact list`);
  } else {
    for (const [index, [sourceRelative, vendorRelative]] of UI_VENDOR_COPIES.entries()) {
      const artifact = manifest.artifacts[index];
      if (
        artifact?.source !== sourceRelative
        || artifact?.destination !== vendorRelative
        || !/^[0-9a-f]{64}$/.test(artifact?.sha256)
      ) {
        manifestProblems.push(`${vendorRelative} has missing or inconsistent manifest metadata`);
        continue;
      }
      const vendor = join(vendorRoot, vendorRelative);
      if (!existsSync(vendor) || hashPath(vendor) !== artifact.sha256) {
        manifestProblems.push(vendorRelative);
      }
    }
    if (manifest.artifacts.length !== UI_VENDOR_COPIES.length) {
      manifestProblems.push(
        `${UI_VENDOR_HASH_MANIFEST} contains ${manifest.artifacts.length} artifacts; expected ${UI_VENDOR_COPIES.length}`,
      );
    }
  }
}

if (manifestProblems.length) {
  console.error(
    `[vendor-check] committed vendor does not match its manifest:\n${
      manifestProblems.map((path) => `  ${path}`).join("\n")
    }`,
  );
  console.error(
    "[vendor-check] restore the committed files, or run npm run sync-ui for an intentional vendor update",
  );
  process.exit(1);
}

const revision = manifest.source?.revision;
const revisionLabel = typeof revision === "string"
  ? `${revision}${manifest.source?.filesMatchRevision === false ? " (copied source files modified)" : ""}`
  : "unknown source revision";

if (!vendorOnly && explicitExtensionRoot && !existsSync(extensionRoot)) {
  console.error(`[vendor-check] extension source not found at ${extensionRoot}`);
  process.exit(1);
}

if (vendorOnly || !existsSync(extensionRoot)) {
  console.log(
    `[vendor-check] ${UI_VENDOR_COPIES.length} committed artifacts match their manifest (${revisionLabel})`,
  );
  if (!vendorOnly) {
    console.log(`[vendor-check] sibling extension repo not found at ${extensionRoot}; source comparison skipped`);
  }
  process.exit(0);
}

const stale = [];
for (const [sourceRelative, vendorRelative] of UI_VENDOR_COPIES) {
  const source = join(extensionRoot, sourceRelative);
  const vendor = join(vendorRoot, vendorRelative);
  if (!existsSync(source) || !existsSync(vendor) || hashPath(source) !== hashPath(vendor)) {
    stale.push(vendorRelative);
  }
}

if (stale.length) {
  console.error(
    `[vendor-check] stale vendor artifacts compared with sibling source:\n${
      stale.map((path) => `  ${path}`).join("\n")
    }`,
  );
  console.error("[vendor-check] stale vendor; run npm run sync-ui");
  process.exit(1);
}

console.log(
  `[vendor-check] ${UI_VENDOR_COPIES.length} artifacts match their manifest and ${extensionRoot} (${revisionLabel})`,
);
