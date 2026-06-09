#!/usr/bin/env node
// gen-architecture-map.mjs — deterministically (re)generate docs/architecture-map.json from the
// filesystem. Single responsibility: serialize the machine-readable navigation map. Byte-stable: two
// runs on the same tree produce identical output. Claude owns the prose (docs/ARCHITECTURE_MAP.md);
// this owns the JSON. See navigation-map-spec.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMap, DEPENDENCIES, ROOTS } from "./lib/arch-map.mjs";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const built = buildMap(cwd);

// Fixed key order for stable diffs (JSON.stringify preserves insertion order for string keys).
const map = {
  status: built.fileCount === 0 ? "planned" : "live",
  generatedBy: ".claude/hooks/gen-architecture-map.mjs",
  generatedFrom: [
    "docs/planning/16-code-organization.md",
    "docs/planning/02-architecture.md",
    "docs/planning/05-features-modules.md",
    "docs/planning/11-information-architecture.md",
  ],
  roots: ROOTS,
  domains: built.domains,
  fileCount: built.fileCount,
  fileSetHash: built.fileSetHash,
  features: built.features,
  shared: built.shared,
  unassigned: built.unassigned,
  warnings: built.warnings,
  dependencies: DEPENDENCIES,
};

const outDir = join(cwd, "docs");
const outFile = join(outDir, "architecture-map.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(map, null, 2) + "\n", "utf8");

// Human-facing summary on stdout (this script is run by Claude / npm, not as a hook).
const lines = [
  `architecture-map.json written — status=${map.status}, files=${map.fileCount}`,
  `  domains with code: ${Object.keys(map.features).length}`,
  `  shared areas:      ${Object.keys(map.shared).length}`,
];
if (map.unassigned.length) lines.push(`  ⚠ unassigned (fix placement): ${map.unassigned.length}`);
if (map.warnings.length) lines.push(`  ⚠ warnings: ${map.warnings.length}`);
lines.push(`  fileSetHash: ${map.fileSetHash}`);
process.stdout.write(lines.join("\n") + "\n");
