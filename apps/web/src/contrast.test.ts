// contrast.test.ts — WCAG 2.2 AA contrast for the pairs the CUSTOMER app paints.
//
// apps/doc has had a contrast guard since its redesign; apps/web, apps/admin and apps/forge never have —
// the surfaces a paying user is actually in all day. This is web's half: assert the colour pairs this app
// puts on screen, and record the one token that fails.
//
// THE FINDING (2026-08-22): `--tp-ink-4` (#9ca3af) is used as a TEXT colour across the product. It scores
// 2.54:1 on pure white and less on every tinted surface (2.43 on --tp-surface-2, 2.33 on --tp-surface-3,
// 2.31 on --nav-hover-fill). AA asks 4.5:1 for normal text and 3.0:1 for large, so it is below BOTH floors —
// there is no text size at which it passes. Not a small-print trade-off; it fails outright.
//
// The selectors say what the text is: `.note`, `.footnote`, `.kpiLabel`, `.fieldLabel`, `.optionHint`,
// `.sectionHint`, `.timelineTime`, `.threadTime`, `.taskSub`, `.secondaryLabel`, `.scoreCompositeLabel`,
// `.wsSlug`, `.tp-ui-page-header-eyebrow`, `.tp-ui-field-hint`. Labels, hints, timestamps and footnotes —
// informational text someone is expected to read. The set does contain genuinely exempt cases
// (`.tp-ui-field::placeholder`, icon glyphs like `.tp-ws-caret`), but they are the minority.
//
// Migrating is a per-surface DESIGN decision, not a find-and-replace: `--tp-ink-3` clears AA on white (4.83)
// and --tp-surface-2 (4.63) but FAILS on --tp-surface-3 (4.43) and --nav-hover-fill (4.39) — the two
// pairings apps/doc shipped broken and had to repair. Both facts are asserted below so the reasoning cannot
// rot silently.

import { describe, expect, test } from "bun:test";

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

// The COUNT of ink-4-as-text usages is ratcheted in packages/ui/src/inkFourContrast.test.ts — with the
// token, because the usages span every app and a ratchet parked in one app that fails when somebody edits
// another is the kind of test people delete. It also matches both spellings; the version that briefly lived
// here matched only the stylesheet form and undercounted by 23.
