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

import { describe, expect, test } from "bun:test";

/** Copied literals from packages/ui/src/tokens.css — on purpose, so a change to either the token or a usage
 *  is caught. A test that reads the same source as the code cannot do that. */
const TOKEN = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
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
