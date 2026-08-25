#!/usr/bin/env node
// lint-alias-cycles.mjs — import cycles among the frontend apps, counting the `@/…` edges depcruise cannot see.
//
// WHY THIS EXISTS. `.dependency-cruiser.cjs` carries a `no-circular` rule at severity "error", and that rule is
// blind: dependency-cruiser is configured with no `options.tsConfig`, while every app's tsconfig maps
// `"@/*"` to `"./src/*"`. An import written `@/lib/foo` therefore resolves to nothing and contributes no edge,
// so a cycle formed entirely (or even partly) out of alias imports is invisible to it. The same blindness is
// documented there for `no-cross-feature-import` (compensated by lint:cross-feature, which ratchets its nine
// known instances) and for `no-orphans` (whose ~14 reports were re-verified as false positives on 2026-08-25 —
// each of the six flagged lib modules has real importers: 32, 14, 11, 8, 2 and 1 of them).
//
// `no-circular` was the one left with no compensating control. Its clean bill of health was a ONE-OFF
// measurement recorded in a comment — "MEASURED CLEAN … found ZERO cycles" over 976 modules — which was true
// when it was taken and says nothing about the commit after it. This turns that measurement into a check.
//
// Run against `main`, this reproduces that census EXACTLY — 976 modules, split web 490 / admin 204 / auth 100
// / doc 82 / extension 54 / forge 46, matching the recorded numbers app for app, and still zero cycles. That
// agreement is the reason to trust it: two independent implementations resolving the same aliases arrived at
// the same graph. The count is higher on any branch that adds modules (1002 here), which is why what the gate
// asserts is CYCLES and never a module count — a count would fail on every honest addition.
//
// FIXING DEPCRUISE PROPERLY IS A BIGGER JOB, deliberately not attempted here. Giving it a tsConfig would make
// all three rules see aliases at once — including `no-cross-feature-import` at severity "error", which would
// immediately fail on the nine known cross-feature imports and turn CI red. That is a project (resolve the
// nine, then switch resolution on), not a side-effect of adding a cycle check.
//
// WHAT IT RESOLVES, and what it does not:
//   • `@/x`  → `apps/<app>/src/x`, the tsconfig mapping, per app.
//   • `./x` / `../x` → normalised against the importing file.
//   • bare specifiers (`react`, `@leadwolf/ui`) are NOT intra-app edges and are skipped — cross-PACKAGE cycles
//     are depcruise's `no-circular` job on paths it can already see.
//   • extensions and index files are probed in tsconfig order (.ts, .tsx, /index.ts, /index.tsx).
//   • `.test.ts` / `.itest.ts` are excluded, matching the cruiser's own exclude list: a test importing the
//     module it tests is not an architectural cycle.
//
// Proven able to fail before being trusted (scripts/lint-gates-selftest.mjs plants one): two modules importing
// each other — one edge by alias, one relative — are reported as a cycle, and the count returns to zero when
// they are removed.
//
// Run: `node scripts/lint-alias-cycles.mjs` (wired as `bun run lint:alias-cycles`).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APPS = ["web", "admin", "auth", "doc", "extension", "forge"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);

/** Every source module under an app's src/, POSIX-normalised so the paths compare on Windows too. */
function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an app without a src/ is not an error here
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|itest)\.tsx?$/.test(entry)) {
      out.push(full.split("\\").join("/"));
    }
  }
  return out;
}

/** Static `from "…"` specifiers plus dynamic `import("…")`. */
const IMPORT =
  /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) {
    const app = fromFile.split("/")[1]; // apps/<app>/src/…
    base = `apps/${app}/src/${spec.slice(2)}`;
  } else if (spec.startsWith(".")) {
    const parts = `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`.split("/");
    const out = [];
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    base = out.join("/");
  } else {
    return null; // bare specifier — a package edge, not an intra-app one
  }
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand.split("\\").join("/");
  }
  return null; // unresolvable (a .css, a generated file, a typo) — not an edge we can claim
}

const files = [];
for (const app of APPS) sourceFiles(`apps/${app}/src`, files);

const graph = new Map();
let edges = 0;
for (const file of files) {
  const deps = new Set();
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const resolved = resolveSpecifier(spec, file);
    if (resolved && resolved !== file) deps.add(resolved);
  }
  graph.set(file, [...deps]);
  edges += deps.size;
}

// Iterative DFS with an explicit stack. A recursive colouring walk overflows on a graph this size, and an
// overflow here would read as "the check crashed" rather than "the check found something".
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const colour = new Map(files.map((f) => [f, WHITE]));
const cycles = new Set();

for (const start of files) {
  if (colour.get(start) !== WHITE) continue;
  colour.set(start, GREY);
  const stack = [[start, 0]];
  const path = [start];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const deps = graph.get(top[0]) ?? [];
    if (top[1] >= deps.length) {
      colour.set(top[0], BLACK);
      stack.pop();
      path.pop();
      continue;
    }
    const next = deps[top[1]];
    top[1] += 1;
    const seen = colour.get(next);
    if (seen === GREY) {
      // Back-edge into the current path: everything from that point on is the cycle.
      cycles.add([...path.slice(path.indexOf(next)), next].join(" -> "));
    } else if (seen === WHITE) {
      colour.set(next, GREY);
      stack.push([next, 0]);
      path.push(next);
    }
  }
}

const perApp = APPS.map(
  (a) => `${a} ${files.filter((f) => f.startsWith(`apps/${a}/`)).length}`,
).join(", ");

if (cycles.size === 0) {
  process.stdout.write(
    `ok   ${files.length} modules (${perApp}) · ${edges} intra-app edges · no import cycles\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${cycles.size} import cycle(s) among the app modules, including \`@/…\` edges depcruise cannot see:\n${[
    ...cycles,
  ]
    .map((c) => `  ${c}`)
    .join(
      "\n",
    )}\n\nA cycle is not a style problem here: it makes module init order load-bearing, and the symptom is an\nundefined import at runtime in whichever module the bundler happens to evaluate first — which can differ\nbetween dev and a production build. Break it by moving the shared value into a module both sides import.\n`,
);
process.exit(1);
