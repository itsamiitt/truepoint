// inkFourContrast.test.ts — a repo-wide ratchet on `--tp-ink-4` used as a TEXT colour.
//
// This lives in packages/ui because that is where the token is defined, and because the usages span every
// app: a ratchet parked in one app that fails when somebody edits another is the kind of test people delete.
// The per-app PAIR assertions stay per-app (apps/web/src/contrast.test.ts, apps/doc/src/components/
// contrast.test.ts) — those are about what a given surface paints. This file is about one token everywhere.
//
// THE MEASUREMENT (2026-08-22). `--tp-ink-4` is #9ca3af. Against the surfaces this product paints:
//
//     on --tp-surface (#ffffff)      2.54:1
//     on --tp-surface-2 (#f9fafb)    2.43:1
//     on --tp-surface-3 (#f4f5f7)    2.33:1
//     on --nav-hover-fill (#f3f4f6)  2.31:1
//
// WCAG 2.2 AA asks 4.5:1 for normal text and 3.0:1 for large text. Every one of those is below BOTH floors,
// so there is no text size at which this token passes as text. It is legitimate for non-text things — a
// placeholder, a disabled control (1.4.3 exempts those), an icon glyph beside its own label — and the current
// usages do include some of those. They are the minority.
//
// The selectors behind the count say what most of it is: `.note`, `.footnote`, `.kpiLabel`, `.fieldLabel`,
// `.optionHint`, `.sectionHint`, `.timelineTime`, `.threadTime`, `.taskSub`, `.secondaryLabel`,
// `.scoreCompositeLabel`, `.wsSlug`, `.tp-ui-page-header-eyebrow`, `.tp-ui-field-hint`. Labels, hints,
// timestamps and footnotes — informational text somebody is expected to read.
//
// WHY A RATCHET. Migrating is a per-surface DESIGN decision, not a find-and-replace: `--tp-ink-3` clears AA
// on white (4.83) and --tp-surface-2 (4.63) but FAILS on --tp-surface-3 (4.43) and --nav-hover-fill (4.39) —
// the two pairings apps/doc shipped broken and had to repair. So this stops the count growing and leaves the
// decision where it belongs. Lower INK4_TEXT_BUDGET whenever usages come out; it must never rise.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Measured 2026-08-22 across every surface below. */
const INK4_TEXT_BUDGET = 97;

/**
 * BOTH spellings, which is the correction that produced this file.
 *
 * The first version of this check matched only `color: var(--tp-ink-4)` — the stylesheet form — and reported
 * 74. It could not match `color: "var(--tp-ink-4)"`, the inline-JSX-style-object form, because the quote sits
 * between `color:` and `var(`. That is 23 further usages, including every one in apps/admin and apps/auth,
 * which had made those two apps look entirely clean. A ratchet is only as honest as its scan, and one that
 * silently misses a whole syntax gives exactly the false assurance it exists to prevent.
 */
const INK4_AS_TEXT = /color:\s*"?var\(--tp-ink-4\)"?/g;

/** Every surface that paints. apps/forge, apps/extension and apps/doc are at zero and are listed anyway —
 *  the point of a ratchet is that a first usage shows up as a failure, not as a silent drift. */
const ROOTS = [
  "apps/web/src",
  "apps/admin/src",
  "apps/auth/src",
  "apps/forge/src",
  "apps/doc/src",
  "apps/extension/src",
  "packages/ui/src",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function styleFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) styleFiles(full, out);
    else if (entry.endsWith(".css") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function countByRoot(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of ROOTS) {
    let total = 0;
    for (const file of styleFiles(join(REPO_ROOT, root))) {
      total += readFileSync(file, "utf8").match(INK4_AS_TEXT)?.length ?? 0;
    }
    counts[root] = total;
  }
  return counts;
}

function totalUsages(): number {
  return Object.values(countByRoot()).reduce((sum, n) => sum + n, 0);
}

describe("--tp-ink-4 as a text colour", () => {
  test("the count does not grow", () => {
    expect(totalUsages()).toBeLessThanOrEqual(INK4_TEXT_BUDGET);
  });

  test("INK4_TEXT_BUDGET is honest — tighten it whenever usages are removed", () => {
    expect(totalUsages()).toBe(INK4_TEXT_BUDGET);
  });

  test("the scan finds both spellings, not just the stylesheet one", () => {
    // Guards the bug this file was written to fix. If the inline-JSX form stops matching, the count silently
    // drops by ~23 and the ratchet "improves" for entirely the wrong reason.
    const css = "color: var(--tp-ink-4);";
    const jsx = 'style={{ color: "var(--tp-ink-4)", fontSize: 12 }}';
    expect(css.match(INK4_AS_TEXT)?.length).toBe(1);
    expect(jsx.match(INK4_AS_TEXT)?.length).toBe(1);
  });

  test("apps/web and packages/ui both still carry usages (a ratchet on zero passes vacuously)", () => {
    const counts = countByRoot();
    expect(counts["apps/web/src"]).toBeGreaterThan(0);
    expect(counts["packages/ui/src"]).toBeGreaterThan(0);
  });
});
