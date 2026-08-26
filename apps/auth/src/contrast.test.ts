// contrast.test.ts — WCAG 2.2 AA for the pairs the AUTH ORIGIN paints.
//
// The fourth per-app contrast guard (apps/web, apps/doc, apps/admin, here). apps/auth had none, and that gap
// is not academic: it is exactly why four `--tp-ink-4` text usages survived in the one app whose entire job is
// to be legible to someone who is locked out. The token is #9ca3af — 2.54:1 on white, below the 4.5:1 normal-
// text floor AND below the 3.0:1 large-text floor, so no font size rescued them. They were the workspace and
// org member/role chips, the "(optional)" in the mock IdP's label, and the "Current" marker in the sessions
// table. All four now read as ink-2 or ink-3, and the last section of this file stops them coming back.
//
// WHAT THIS FOUND BEYOND THE FOUR. The two picker chips could NOT simply move to ink-3, which is the reflex
// fix. A `.tp-ui-radio-option` fills with --tp-surface-3 the moment it is `:checked`, and the org/workspace
// pickers mark their first row `defaultChecked` — so the chip's real background is the tinted one on arrival.
// ink-3 there is 4.43:1: still under the floor, just less obviously. They are ink-2 (9.45:1) for that reason,
// and the negative control below pins the 4.43 so the "obvious" fix cannot be applied later by someone who
// only checked it against white.
//
// This file deliberately duplicates apps/admin's shape, with one correction: --tp-ink-4 IS in the TOKEN map.
// apps/admin omits it, which means the app that documents the ink-4 bug cannot actually assert anything about
// it. A guard that cannot express the failure it was written for is decoration.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Literals copied from packages/ui/src/tokens.css, on purpose: a test that reads the same source as the code
 *  cannot catch a token moving out from under a usage. Change one there, this fails here. */
const TOKEN = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
  "--tp-ink-4": "#9ca3af",
  "--tp-on-fill": "#ffffff",
  "--tp-surface": "#ffffff",
  "--tp-surface-2": "#f9fafb",
  "--tp-surface-3": "#f4f5f7",
  "--nav-hover-fill": "#f3f4f6",
  "--tp-btn": "#111827",
  "--tp-cobalt": "#2563c9",
  "--success": "#16a34a",
  "--danger": "#dc2626",
  "--danger-700": "#b91c1c",
  "--focus-ring": "#6b7280",
} as const;

type Token = keyof typeof TOKEN;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
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
/** WCAG 2.2 SC 1.4.11: a graphic that CARRIES meaning needs 3:1, not 4.5:1. */
const NON_TEXT = 3.0;

/**
 * Every (text colour, background) pair this origin paints. ADD A ROW when you introduce one — a pair not
 * listed is a pair nobody checked, which is the state this app was in.
 *
 * The backgrounds, so the pairing is checkable rather than assumed:
 *   --tp-surface     the AuthShell card, the AccountShell Card, .tp-ui-field, the StatusBadge pill
 *   --tp-surface-2   the PAGE (globals.css sets body) — anything outside a card sits on this
 *   --tp-surface-3   .tp-ui-alert--default, .tp-ui-badge, .tp-ui-btn--secondary, a :checked RadioOption
 *   --nav-hover-fill .tp-ui-btn--secondary:hover and .tp-ui-btn--ghost:hover
 *   --tp-btn         .tp-ui-btn--primary (every SubmitButton on every screen)
 */
const TEXT_PAIRS: readonly { fg: Token; bg: Token; where: string }[] = [
  { fg: "--tp-ink", bg: "--tp-surface", where: "card copy, headings, labels, field values" },
  { fg: "--tp-ink", bg: "--tp-surface-2", where: "the AccountShell page title, on the page" },
  { fg: "--tp-ink", bg: "--tp-surface-3", where: "a selected org/workspace row; secondary button" },
  { fg: "--tp-ink", bg: "--nav-hover-fill", where: "secondary/ghost button label, on hover" },
  { fg: "--tp-ink-2", bg: "--tp-surface", where: "StatusBadge label; ghost button at rest" },
  {
    fg: "--tp-ink-2",
    bg: "--tp-surface-3",
    where: "Alert body, Badge, the picker role/owner chip",
  },
  { fg: "--tp-ink-3", bg: "--tp-surface", where: "card subtitles, table meta cells, 'Current'" },
  { fg: "--tp-ink-3", bg: "--tp-surface-2", where: "the AccountShell subtitle + section nav" },
  { fg: "--tp-on-fill", bg: "--tp-btn", where: "the primary submit button" },
  { fg: "--danger", bg: "--tp-surface", where: ".linkDanger — 'Sign out' in the sessions table" },
  { fg: "--danger-700", bg: "--tp-surface", where: "every destructive Alert (all sit on a card)" },
];

describe("WCAG 2.2 AA — every text pair apps/auth paints", () => {
  for (const { fg, bg, where } of TEXT_PAIRS) {
    test(`${fg} on ${bg} (${where})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

/** Meaningful non-text graphics: 3:1 under SC 1.4.11, not 4.5:1. */
const GRAPHIC_PAIRS: readonly { fg: Token; bg: Token; where: string }[] = [
  { fg: "--focus-ring", bg: "--tp-surface", where: "the focus ring on a card" },
  { fg: "--focus-ring", bg: "--tp-surface-2", where: "the focus ring on the page" },
  { fg: "--focus-ring", bg: "--tp-surface-3", where: "the focus ring on a selected picker row" },
  { fg: "--tp-cobalt", bg: "--tp-surface", where: "the BrandLockup chevron's top stroke" },
  { fg: "--success", bg: "--tp-surface", where: "the StatusBadge dot on 'This device' / 'On'" },
];

describe("WCAG 2.2 SC 1.4.11 — the non-text graphics", () => {
  for (const { fg, bg, where } of GRAPHIC_PAIRS) {
    test(`${fg} on ${bg} (${where})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }

  // StatusBadge tone="muted" paints its dot --tp-ink-4 (2.54:1) — the "Ended" row in the login history. It is
  // NOT listed above and that is deliberate, not an oversight: the word "Ended" sits inside the same pill, so
  // the dot conveys nothing the text does not, and 1.4.11 exempts a graphic whose information is also in text.
  // Recorded here because "it is missing from the list" and "it was checked and is exempt" look identical.
  test("the muted StatusBadge dot is decorative, and would fail if it were not", () => {
    expect(contrast("--tp-ink-4", "--tp-surface")).toBeLessThan(NON_TEXT);
  });
});

describe("the check can fail", () => {
  // Negative control. Without these the block above could be passing vacuously — every one of these pairs is
  // reachable in this app's palette, and each is below the floor.
  test("--tp-ink-4 fails as text on every surface this origin paints", () => {
    expect(contrast("--tp-ink-4", "--tp-surface")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-4", "--tp-surface-2")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-4", "--tp-surface-3")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-4", "--nav-hover-fill")).toBeLessThan(AA_NORMAL);
  });

  test("...and below the LARGE-text floor too, so no font size rescues it", () => {
    expect(contrast("--tp-ink-4", "--tp-surface")).toBeLessThan(NON_TEXT);
  });

  test("why the picker chips are ink-2 and not the reflex ink-3", () => {
    // A RadioOption fills --tp-surface-3 when :checked, and the first option is defaultChecked.
    expect(contrast("--tp-ink-3", "--tp-surface-3")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-3", "--nav-hover-fill")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-2", "--tp-surface-3")).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test("black on white is 21:1 — the arithmetic is real", () => {
    expect(contrast("--tp-ink", "--tp-surface")).toBeGreaterThan(15);
  });
});

describe("--tp-ink-4 is never a text colour in apps/auth", () => {
  // The per-app half of packages/ui's repo-wide ratchet. That one caps the TOTAL; this one holds THIS app at
  // zero, so a regression here fails in the app that caused it instead of in someone else's package.
  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo"]);

  /** BOTH spellings: `color: var(--tp-ink-4)` in a stylesheet and `color: "var(--tp-ink-4)"` in a style
   *  object. Matching only the first is the bug that made this app look clean while it had four. */
  const INK4_AS_TEXT = /color:\s*"?var\(--tp-ink-4[^)]*\)"?/;

  function styleFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) styleFiles(full, out);
      // What paints: stylesheets and components. Tests do not — and this file, being .ts, is outside the
      // scan by construction, which is what lets it spell the banned pattern out below.
      else if (/\.(css|tsx)$/.test(entry) && !entry.endsWith(".test.tsx")) out.push(full);
    }
    return out;
  }

  test("no stylesheet or component in this app sets a text colour to --tp-ink-4", () => {
    const root = import.meta.dir;
    const scanned = styleFiles(root);
    // Assert the probe RAN. An empty file list passes the offender check for entirely the wrong reason, and
    // this repo has shipped that exact shape of vacuous green before.
    expect(scanned.length).toBeGreaterThan(20);
    const offenders = scanned
      .filter((file) => INK4_AS_TEXT.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });

  test("the scan matches both spellings (a scan that misses one guards nothing)", () => {
    const css = `color: ${"var(--tp-ink-4)"};`;
    const jsx = `style={{ color: ${JSON.stringify("var(--tp-ink-4)")} }}`;
    const withFallback = `color: ${"var(--tp-ink-4, #9ca3af)"};`;
    expect(INK4_AS_TEXT.test(css)).toBe(true);
    expect(INK4_AS_TEXT.test(jsx)).toBe(true);
    expect(INK4_AS_TEXT.test(withFallback)).toBe(true);
    expect(INK4_AS_TEXT.test('color: "var(--tp-ink-3)"')).toBe(false);
  });
});
