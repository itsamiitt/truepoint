#!/usr/bin/env node
// check-architecture-map.mjs — Stop hook. Single responsibility: detect that the source FILE SET changed
// without the navigation map being regenerated, and nudge once. READ-ONLY w.r.t. the repo (it only writes
// its own debounce stamp under .claude/). Gated on fileSetHash (not mtime/content), so it never fires on
// git checkout / npm install churn. See navigation-map-spec.md + map-maintenance.md.
//
// Output: by default emits {"decision":"block","reason":...} to make Claude refresh the map at task end.
// Set ARCH_MAP_HOOK_MODE=advisory to downgrade to a non-blocking hookSpecificOutput.additionalContext.
// Loop-safe: honors stop_hook_active and a time debounce so it can't block repeatedly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMap, rootsExist } from "./lib/arch-map.mjs";

const DEBOUNCE_MS = Number(process.env.ARCH_MAP_HOOK_DEBOUNCE_MS || 120000); // 2 min default
const ADVISORY = process.env.ARCH_MAP_HOOK_MODE === "advisory";

function allow() {
  process.exit(0); // exit 0 with no stdout = let Claude stop normally
}

async function readStdin() {
  if (process.stdin.isTTY) return ""; // run interactively with no pipe -> empty payload
  const chunks = [];
  try {
    for await (const c of process.stdin) chunks.push(c);
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let payload = {};
try {
  payload = raw ? JSON.parse(raw) : {};
} catch {
  payload = {};
}

// 1. Loop guard: if we already triggered a continuation this stop sequence, let it stop.
if (payload.stop_hook_active === true) allow();

const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// 2. No code yet -> true no-op.
if (!rootsExist(cwd)) allow();

// 3. Compare current file set against the committed map.
const { fileSetHash } = buildMap(cwd);
const mapPath = join(cwd, "docs", "architecture-map.json");

let stale = false;
let why = "";
if (!existsSync(mapPath)) {
  stale = true;
  why = "docs/architecture-map.json is missing";
} else {
  try {
    const stored = JSON.parse(readFileSync(mapPath, "utf8"));
    if (stored.fileSetHash !== fileSetHash) {
      stale = true;
      why = "the source file set changed since the map was generated";
    }
  } catch {
    stale = true;
    why = "docs/architecture-map.json is unreadable";
  }
}

if (!stale) allow();

// 4. Debounce: don't re-nudge if we nudged very recently (handles sequential stops on a big task).
const stampPath = join(cwd, ".claude", ".arch-map-nudge");
const now = Date.now();
if (existsSync(stampPath)) {
  const last = Number(readFileSync(stampPath, "utf8").trim());
  if (Number.isFinite(last) && now - last < DEBOUNCE_MS) allow();
}
try {
  writeFileSync(stampPath, String(now), "utf8");
} catch {
  /* non-fatal: a failed stamp just means we might nudge again sooner */
}

// 5. Emit the nudge.
const reason =
  `Navigation map is stale: ${why}. Run \`node .claude/hooks/gen-architecture-map.mjs\` to rebuild ` +
  `docs/architecture-map.json, then refresh docs/ARCHITECTURE_MAP.md per ` +
  `.claude/skills/enterprise-architecture/reference/navigation-map-spec.md (do not hand-improvise the format).`;

if (ADVISORY) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: reason } }) + "\n"
  );
} else {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}
process.exit(0);
