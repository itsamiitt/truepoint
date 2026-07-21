// check-lockfile.mjs — prove bun.lock is in sync with every workspace package.json BEFORE the image build.
//
// The Dockerfile runs `bun install --frozen-lockfile`, which aborts with the opaque
// "error: lockfile had changes, but lockfile is frozen" and no indication of WHICH dependency drifted.
// Because agents in this repo routinely edit a package.json on a machine without bun, the lockfile can be
// committed one commit behind the manifest that needs it — the deploy then dies eight minutes into a build.
// This runs in milliseconds, needs no network and no node_modules, and names the offending package.
//
// Zero dependencies on purpose: it runs under either node or bun, before anything is installed.

import fs from "node:fs";
import path from "node:path";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** bun.lock is JSONC-flavoured: valid JSON except for trailing commas. */
function readLockfile(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
}

/** Workspace members, as bun globs them from the root package.json `workspaces` field. */
function workspaceDirs(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const dirs = [""];
  for (const glob of pkg.workspaces ?? []) {
    const parent = glob.replace(/\/\*$/, "");
    const abs = path.join(root, parent);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      if (fs.existsSync(path.join(abs, entry, "package.json"))) dirs.push(`${parent}/${entry}`);
    }
  }
  return dirs;
}

const root = process.cwd();
const lockPath = path.join(root, "bun.lock");
if (!fs.existsSync(lockPath)) {
  console.error("ERROR: bun.lock not found at the repo root.");
  process.exit(1);
}

const lock = readLockfile(lockPath);
const mirrors = lock.workspaces ?? {};
const resolved = new Set(Object.keys(lock.packages ?? {}));
const problems = [];

for (const dir of workspaceDirs(root)) {
  const label = dir || "(root)";
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, dir, "package.json"), "utf8"),
  );
  const mirror = mirrors[dir];
  if (!mirror) {
    problems.push(`${label}: no entry in bun.lock — the workspace member is missing from the lockfile`);
    continue;
  }

  for (const field of DEP_FIELDS) {
    const declared = manifest[field] ?? {};
    const locked = mirror[field] ?? {};

    for (const [name, range] of Object.entries(declared)) {
      if (locked[name] === undefined) {
        problems.push(`${label}: ${field}."${name}": "${range}" is declared but absent from bun.lock`);
      } else if (locked[name] !== range) {
        problems.push(
          `${label}: ${field}."${name}" is "${range}" in package.json but "${locked[name]}" in bun.lock`,
        );
      }
      // A workspace: range is satisfied by a sibling member, never by an entry in `packages`.
      if (!String(range).startsWith("workspace:") && !resolved.has(name)) {
        problems.push(`${label}: ${field}."${name}" has no resolved entry in the bun.lock packages map`);
      }
    }

    for (const name of Object.keys(locked)) {
      if (declared[name] === undefined) {
        problems.push(`${label}: ${field}."${name}" is in bun.lock but no longer declared in package.json`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("ERROR: bun.lock is out of sync with the workspace manifests.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe image build runs `bun install --frozen-lockfile` and would fail on this." +
      "\nRegenerate the lockfile and commit it:" +
      "\n    bun install" +
      "\nOr, on a host with docker but no bun:" +
      '\n    docker run --rm -v "$PWD":/w -w /w oven/bun:1.3.14 bun install\n',
  );
  process.exit(1);
}

console.log(`bun.lock is in sync (${Object.keys(mirrors).length} workspace members checked).`);
