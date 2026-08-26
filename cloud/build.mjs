// Build the cloud-environment image.
//
// The build context is a `git archive` of the SIBLING extension repo, staged in
// a temp directory alongside this repo's Dockerfile and entrypoint. Three
// reasons, in order of how much time each one saves:
//
//  1. `node_modules` never enters the context. On a Windows host it is ~1.5 GB
//     of binaries that would be useless in a Linux image and would still be
//     uploaded to the daemon first.
//  2. The image cannot contain an uncommitted edit. What runs in a container is
//     a revision you can name, which is the only way a "works in the container,
//     not on the desk" report means anything.
//  3. No stray Dockerfile or .dockerignore has to be committed to the public
//     extension repo to make its own build work.
//
// Run: node cloud/build.mjs [--rev <git-rev>] [--tag <name>]
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const EXT = process.env.GROK_BUILD_VSCODE
  || join(here, "..", "..", "grok-build-vscode");
const REV = flag("rev", "HEAD");
const TAG = flag("tag", "afkpilot-cloud:dev");

if (!existsSync(join(EXT, "package.json"))) {
  console.error(`[build] no extension checkout at ${EXT}`);
  console.error("[build] set GROK_BUILD_VSCODE to point at it");
  process.exit(1);
}

const sha = execFileSync("git", ["-C", EXT, "rev-parse", "--short", REV], { encoding: "utf8" }).trim();
// A dirty tree is not an error — it is a fact worth printing, because the image
// will NOT contain those edits and that surprises people exactly once.
const dirty = execFileSync("git", ["-C", EXT, "status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty) {
  console.log(`[build] note: ${EXT} has uncommitted changes; the image is built from ${sha} and will not contain them`);
}

// `worktree add` wants the path to NOT exist, so nothing is created here.
const stage = join(tmpdir(), `afkpilot-cloud-ctx-${sha}`);

console.log(`[build] staging ${REV} (${sha}) from ${EXT}`);
// A detached worktree, not `git archive | tar`. The pipe form needs a shell
// Node cannot spawn on Windows, and the write-then-extract form runs into GNU
// tar reading `C:\...` as a remote host ("Cannot connect to C: resolve
// failed"). A worktree is pure git, portable, and gives exactly what is
// committed at that revision with no node_modules anywhere near it.
rmSync(stage, { recursive: true, force: true });
execFileSync("git", ["-C", EXT, "worktree", "add", "--detach", "--force", stage, REV], { stdio: "inherit" });

cpSync(join(here, "cloud-entrypoint.sh"), join(stage, "cloud-entrypoint.sh"));
// The worktree leaves a `.git` FILE pointing back at a path that will not exist
// inside the image. Harmless as data, confusing to any git run at /app, and free
// to exclude.
writeFileSync(join(stage, ".dockerignore"), [".git", "node_modules", ".screens", ""].join("\n"));

console.log(`[build] docker build -t ${TAG}`);
execFileSync(
  "docker",
  ["build", "-f", join(here, "Dockerfile"), "-t", TAG, "--label", `grok.rev=${sha}`, stage],
  { stdio: "inherit" },
);

// `remove --force` because the staging tree is deliberately dirty: the
// entrypoint and .dockerignore were written into it.
execFileSync("git", ["-C", EXT, "worktree", "remove", "--force", stage], { stdio: "inherit" });
console.log(`[build] built ${TAG} from ${sha}`);
