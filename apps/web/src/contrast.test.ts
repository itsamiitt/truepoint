// contrast.test.ts — WCAG 2.2 AA contrast for the CUSTOMER app, as a ratchet.
//
// apps/doc has had a contrast guard since its redesign; nothing equivalent has ever guarded apps/web,
// apps/admin or apps/forge — the three surfaces a paying user actually spends the day in. This is the first
// half of closing that, and it is deliberately shaped as a RATCHET rather than a pass/fail wall, because the
// first run found a problem too large to fix as a side effect of adding the check.
//
// THE FINDING (measured 2026-08-22): `--tp-ink-4` is used as a TEXT colour in 74 places across apps/web and
// packages/ui. At #9ca3af it scores **2.54:1 on pure white** and less on every tinted surface this app paints
// (2.43 on --tp-surface-2, 2.33 on --tp-surface-3, 2.31 on --nav-hover-fill). AA asks 4.5:1 for normal text
// and 3.0:1 for large text, so there is **no text size at which this token passes** — it is not a
// "small-print" trade-off, it fails outright at every size.
//
// The selectors say what the text is, and it is not decoration: `.note` (×5), `.footnote` (×3), `.kpiLabel`,
// `.fieldLabel`, `.optionHint`, `.sectionHint`, `.timelineTime`, `.threadTime`, `.taskSub`, `.secondaryLabel`,
// `.scoreCompositeLabel`, `.wsSlug`, `.tp-ui-page-header-eyebrow`, `.tp-ui-field-hint`. Those are labels,
// hints, timestamps and footnotes — informational text a user is expected to read. Genuinely exempt cases
// exist in the set (`.tp-ui-field::placeholder`, and icon glyphs like `.tp-ws-caret`, `.tp-ui-th-arrow`,
// `.tp-ui-chip-x`) but they are a small minority.
//
// WHY A RATCHET AND NOT A FIX. Swapping ink-4 → ink-3 changes the visual hierarchy on most screens in the
// product, and it is not even a mechanical swap: ink-3 clears AA on white (4.83) and --tp-surface-2 (4.63)
// but FAILS on --tp-surface-3 (4.43) and --nav-hover-fill (4.39) — the two pairings apps/doc already shipped
// broken and had to fix. So the correct change is a design decision per surface, not a find-and-replace, and
// making it silently while adding a test would be the wrong way round. What this file does is stop the number
// growing and put the measurement somewhere a human can act on it.
//
// Lower INK4_TEXT_BUDGET whenever usages are removed. A ratchet that is never tightened stops being a ratchet
// (the same rule migrationSnapshots.test.ts states for the snapshot deficit).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Values copied from packages/ui/src/tokens.css — literal on purpose, so a change to either the token or a
 *  usage is caught. A test that reads the same source as the code cannot do that. */
const TOKEN = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
  "--tp-ink-4": "#9ca3af",
  "--tp-cobalt": "#2563c9",
  "--tp-cobalt-700": "#1e4fa3",
  "--tp-btn": "#111827",
  "--tp-on-fill": "#ffffff",
  "--danger-700": "#b91c1c",
  "--tp-surface": "#ffffff",
  "--tp-surface-2": "#f9fafb",
  "--tp-surface-3": "#f4f5f7",
  "--tp-cobalt-50": "#e9f0fc",
  "--nav-hover-fill": "#f3f4f6",
} as const;

type Token = keyof typeof TOKEN;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(fg: Token, bg: Token): number {
  const a = luminance(TOKEN[fg]);
  const b = luminance(TOKEN[bg]);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

/** Pairs this app paints that are NOT in dispute — the ones a reader should be able to trust. */
const SAFE_PAIRS: readonly { fg: Token; bg: Token; where: string }[] = [
  { fg: "--tp-ink", bg: "--tp-surface", where: "body copy, headings" },
  { fg: "--tp-ink-2", bg: "--tp-surface", where: "secondary copy" },
  { fg: "--tp-ink-3", bg: "--tp-surface", where: "muted copy on white" },
  { fg: "--tp-ink-3", bg: "--tp-surface-2", where: "muted copy on the tinted panel" },
  { fg: "--tp-ink", bg: "--tp-surface-2", where: "copy on the tinted panel" },
  { fg: "--tp-cobalt-700", bg: "--tp-surface", where: "links" },
  { fg: "--tp-cobalt-700", bg: "--tp-cobalt-50", where: "active nav item" },
  { fg: "--tp-on-fill", bg: "--tp-cobalt", where: "primary button, the pricing CTA" },
  { fg: "--tp-on-fill", bg: "--tp-btn", where: "dark button" },
  { fg: "--danger-700", bg: "--tp-surface", where: "destructive copy" },
];

describe("WCAG 2.2 AA — pairs apps/web paints that are settled", () => {
  for (const { fg, bg, where } of SAFE_PAIRS) {
    test(`${fg} on ${bg} (${where})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("--tp-ink-4 as text: the measurement behind the ratchet", () => {
  test("fails AA at EVERY text size, on every surface this app paints", () => {
    for (const bg of [
      "--tp-surface",
      "--tp-surface-2",
      "--tp-surface-3",
      "--nav-hover-fill",
    ] as const) {
      // Not "fails for small text" — below the large-text floor too, so no size rescues it.
      expect(contrast("--tp-ink-4", bg)).toBeLessThan(AA_LARGE);
    }
  });

  test("ink-3 is the fix on white and surface-2, and is NOT the fix on the darker tints", () => {
    expect(contrast("--tp-ink-3", "--tp-surface")).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast("--tp-ink-3", "--tp-surface-2")).toBeGreaterThanOrEqual(AA_NORMAL);
    // These two are why the migration is a per-surface design decision rather than a find-and-replace.
    expect(contrast("--tp-ink-3", "--tp-surface-3")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-3", "--nav-hover-fill")).toBeLessThan(AA_NORMAL);
  });
});

/** Measured 2026-08-22. Lower it whenever usages are removed; it must never rise. */
const INK4_TEXT_BUDGET = 74;

const ROOTS = [
  join(import.meta.dir, "..", "..", "..", "apps", "web", "src"),
  join(import.meta.dir, "..", "..", "..", "packages", "ui", "src"),
];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

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

function inkFourTextUsages(): number {
  let count = 0;
  for (const root of ROOTS) {
    for (const file of styleFiles(root)) {
      const matches = readFileSync(file, "utf8").match(/color:\s*var\(--tp-ink-4\)/g);
      count += matches?.length ?? 0;
    }
  }
  return count;
}

describe("--tp-ink-4 text ratchet", () => {
  test("the count does not grow", () => {
    expect(inkFourTextUsages()).toBeLessThanOrEqual(INK4_TEXT_BUDGET);
  });

  test("INK4_TEXT_BUDGET is honest — tighten it whenever usages are removed", () => {
    expect(inkFourTextUsages()).toBe(INK4_TEXT_BUDGET);
  });

  test("the scan actually finds things (a ratchet on zero would pass vacuously)", () => {
    expect(inkFourTextUsages()).toBeGreaterThan(0);
  });
});
