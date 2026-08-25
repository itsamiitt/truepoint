// contrast.test.ts — WCAG 2.2 AA for the pairs the STAFF console paints.
//
// The third of the per-app contrast guards (apps/doc, apps/web, here). apps/admin has almost no stylesheet of
// its own — two globals.css files across admin and forge — because it paints through @leadwolf/ui primitives
// and inline token references. That made it look like it had nothing to check, which is exactly why it went
// unchecked: the first scan of this app reported ZERO --tp-ink-4 text usages, and the real number was four.
// The scan could not see `color: "var(--tp-ink-4)"`, the inline-JSX form this app uses everywhere.
//
// WHAT THIS FOUND. `--success` and `--warning` are FILL tones, not text tones: 3.30:1 and 3.19:1 on white,
// both under the 4.5:1 AA floor for normal text. They were the colour of two numbers in this app — a failure
// count in the AI-usage table and a credit delta in the tenant ledger. Behind a status dot or a check icon
// they are fine (WCAG 1.4.11 asks 3:1 of a meaningful graphic, and both clear it); as the colour of a number
// they are not. `--danger-700` already existed for exactly this reason on the red side, so the fix was the
// missing half of an established pattern rather than a new idea: `--success-700` (#15803d, 5.02:1) and
// `--warning-700` (#b45309, 5.02:1), and the two call sites now use them.
//
// The rule those tokens encode, asserted below so it cannot quietly rot: status colour on a FILL or an ICON
// uses the base tone; status colour on TEXT uses the -700.
//
// AND THE TOKEN THE HEADER WAS ABOUT. The paragraph above says the first scan reported ZERO `--tp-ink-4` text
// usages when the real number was four — and then the TOKEN map below omitted `--tp-ink-4`, so this file could
// not measure the very token whose absence it was written to explain. It is in the map now, with the ratio
// asserted (2.54:1 on white: below the 4.5:1 normal-text floor AND the 3.0:1 large-text one, so there is no
// text size at which it passes) and with a scan that keeps this app at zero ink-4 TEXT usages.
//
// All four were in components/EntityPicker.tsx: a "Searching…" line, a "no matches" line, and the option
// hints. They went with the hand-rolled combobox that file used to be — the DS <Combobox> paints those in
// --tp-ink-3. ink-4 is still correct where it is NOT text: a placeholder, a disabled control, a decorative
// glyph beside its own label. The scan below only looks at `color:`, so those stay legal.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Copied literals from packages/ui/src/tokens.css — on purpose, so a change to either the token or a usage
 *  is caught. A test that reads the same source as the code cannot do that. */
const TOKEN = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
  /** NOT a text tone. In the map so the assertions below can prove that rather than assume it. */
  "--tp-ink-4": "#9ca3af",
  "--tp-surface": "#ffffff",
  "--tp-surface-2": "#f9fafb",
  "--tp-surface-3": "#f4f5f7",
  "--tp-cobalt": "#2563c9",
  "--tp-cobalt-700": "#1e4fa3",
  "--tp-on-fill": "#ffffff",
  "--success": "#16a34a",
  "--success-700": "#15803d",
  "--warning": "#d97706",
  "--warning-700": "#b45309",
  "--danger": "#dc2626",
  "--danger-700": "#b91c1c",
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
/** WCAG 1.4.3: 18.66px bold / 24px text clears at 3:1. Also WCAG 1.4.11's floor for a meaningful graphic. */
const AA_LARGE = 3.0;
/** WCAG 1.4.11: a graphic that carries meaning needs 3:1, not 4.5:1. */
const NON_TEXT = 3.0;

const TEXT_PAIRS: readonly { fg: Token; bg: Token; where: string }[] = [
  { fg: "--tp-ink", bg: "--tp-surface", where: "table cells, headings" },
  { fg: "--tp-ink-2", bg: "--tp-surface", where: "secondary copy" },
  { fg: "--tp-ink-3", bg: "--tp-surface", where: "muted copy, column hints" },
  { fg: "--tp-ink-3", bg: "--tp-surface-2", where: "muted copy on the tinted row" },
  { fg: "--tp-cobalt-700", bg: "--tp-surface", where: "links" },
  { fg: "--tp-on-fill", bg: "--tp-cobalt", where: "primary button" },
  { fg: "--danger-700", bg: "--tp-surface", where: "destructive copy" },
  { fg: "--success-700", bg: "--tp-surface", where: "the tenant-ledger credit delta" },
  { fg: "--warning-700", bg: "--tp-surface", where: "the AI-usage non-ok count" },
  { fg: "--success-700", bg: "--tp-surface-2", where: "the same, on a zebra row" },
  { fg: "--warning-700", bg: "--tp-surface-2", where: "the same, on a zebra row" },
];

describe("WCAG 2.2 AA — text pairs apps/admin paints", () => {
  for (const { fg, bg, where } of TEXT_PAIRS) {
    test(`${fg} on ${bg} (${where})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("the status tones are fills, not text", () => {
  // The finding this file exists to pin. If either of these ever passes AA, the -700 variants have become
  // redundant and the rule should be revisited — but silently reverting the call sites must not be an option.
  test("--success and --warning FAIL as text", () => {
    expect(contrast("--success", "--tp-surface")).toBeLessThan(AA_NORMAL);
    expect(contrast("--warning", "--tp-surface")).toBeLessThan(AA_NORMAL);
  });

  test("...and PASS as a meaningful graphic, which is what they are for", () => {
    expect(contrast("--success", "--tp-surface")).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast("--warning", "--tp-surface")).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast("--danger", "--tp-surface")).toBeGreaterThanOrEqual(NON_TEXT);
  });

  test("the -700 variants are strictly darker than their base tone", () => {
    expect(luminance(TOKEN["--success-700"])).toBeLessThan(luminance(TOKEN["--success"]));
    expect(luminance(TOKEN["--warning-700"])).toBeLessThan(luminance(TOKEN["--warning"]));
  });
});

/**
 * `color:` only, and both spellings — the stylesheet form and the inline-JSX one this app writes everywhere.
 * The scan the file's header describes missed the second because the quote sits between `color:` and `var(`,
 * which is how four real usages read as zero. A `background`/`borderColor`/placeholder use of ink-4 is fine
 * and deliberately not matched.
 */
const INK4_AS_TEXT = /color:\s*"?var\(--tp-ink-4\)"?/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      sourceFiles(full, out);
      // This file quotes the pattern it searches for; scanning itself would make the count self-fulfilling.
    } else if ((full.endsWith(".tsx") || full.endsWith(".css")) && !full.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

describe("--tp-ink-4 is a non-text token", () => {
  test("it fails AA at every text size, on every surface this console paints", () => {
    for (const bg of ["--tp-surface", "--tp-surface-2", "--tp-surface-3"] as const) {
      expect(contrast("--tp-ink-4", bg)).toBeLessThan(AA_LARGE);
      expect(contrast("--tp-ink-4", bg)).toBeLessThan(AA_NORMAL);
    }
  });

  test("...so apps/admin paints no TEXT with it", () => {
    const offenders = sourceFiles(import.meta.dir)
      .map((f) => [f, readFileSync(f, "utf8").match(INK4_AS_TEXT)?.length ?? 0] as const)
      .filter(([, n]) => n > 0)
      .map(([f, n]) => `${f.replace(/\\/g, "/").split("/apps/")[1]} ×${n}`);
    expect(offenders).toEqual([]);
  });

  test("the scan sees both spellings (the bug that made four usages read as zero)", () => {
    expect("color: var(--tp-ink-4);".match(INK4_AS_TEXT)?.length).toBe(1);
    expect('style={{ color: "var(--tp-ink-4)" }}'.match(INK4_AS_TEXT)?.length).toBe(1);
    // A non-text use of the same token is NOT a finding.
    expect('style={{ borderColor: "var(--tp-ink-4)" }}'.match(INK4_AS_TEXT)).toBeNull();
  });
});
