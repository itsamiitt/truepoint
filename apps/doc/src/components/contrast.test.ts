// contrast.test.ts — WCAG 2.2 AA contrast, asserted rather than assumed.
//
// This exists because the assumption failed. Three surfaces in this app shipped muted text below the 4.5:1
// floor: the code-block language label (--tp-ink-3 on --tp-surface-3 = 4.43:1) and two cells in the endpoint
// index whose row tints to --nav-hover-fill on hover (4.39:1). All three looked fine in review and read as
// obviously-correct token usage — ink-3 IS the muted-text token, and it does clear AA on white. It is the
// pairing with a tinted background that fails, and nothing in the design system stops you making it.
//
// truepoint-design has no automated token lint (its own implementation-status note says so), so the rule is
// enforced here for this app's palette. Two guards:
//   1. Every foreground/background pair the app actually uses is asserted against the AA floor.
//   2. --tp-ink-4 is banned outright as a text colour, because it fails on EVERY surface this app paints.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Values copied from packages/ui/src/tokens.css. Kept literal on purpose: the point is to catch a change
 *  to either the token or the usage, and a test that reads the same source as the code cannot do that. */
const TOKEN = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
  "--tp-ink-4": "#9ca3af",
  "--tp-cobalt": "#2563c9",
  "--tp-cobalt-700": "#1e4fa3",
  "--tp-btn": "#111827",
  "--tp-on-fill": "#ffffff",
  "--tp-twilight": "#0c0e1a",
  "--danger-ink": "#8c5f5f",
  "--tp-surface": "#ffffff",
  "--tp-surface-2": "#f9fafb",
  "--tp-surface-3": "#f4f5f7",
  "--tp-cobalt-50": "#e9f0fc",
  "--nav-hover-fill": "#f3f4f6",
  /* The dark code panel paints white at measured alphas over --tp-twilight. These are the composited
     results (alpha·255 + (1−alpha)·channel), asserted here because rgba cannot be — change an alpha in
     prose.module.css and its blend here must move with it. */
  "--blend-code-label": "#a3a3a8" /* rgba(255,255,255,.62) over twilight */,
  "--blend-code-copy": "#dbdbdd" /* rgba(255,255,255,.85) over twilight */,
  "--blend-code-text": "#ececee" /* rgba(255,255,255,.92) over twilight */,
} as const;

type Token = keyof typeof TOKEN;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: Token, bg: Token): number {
  const a = luminance(TOKEN[fg]);
  const b = luminance(TOKEN[bg]);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;

/** Every (text colour, background) pair this app paints. ADD A ROW HERE when you introduce a new one —
 *  that is the whole mechanism. A pair not listed is a pair nobody checked. */
const USED_PAIRS: readonly { fg: Token; bg: Token; where: string }[] = [
  { fg: "--tp-ink", bg: "--tp-surface", where: "body copy, headings" },
  { fg: "--tp-ink-2", bg: "--tp-surface", where: "prose paragraphs, card bodies" },
  { fg: "--tp-ink-3", bg: "--tp-surface", where: "eyebrows, section notes, changelog dates" },
  { fg: "--tp-ink-3", bg: "--tp-surface-2", where: "footer headings and notes" },
  { fg: "--tp-ink", bg: "--tp-surface-3", where: "inline code" },
  { fg: "--tp-ink", bg: "--tp-surface-2", where: "facts-strip base URL, on the tinted bar" },
  { fg: "--tp-ink-2", bg: "--nav-hover-fill", where: "endpoint-index row cells, on hover" },
  { fg: "--tp-ink", bg: "--nav-hover-fill", where: "nav and sidebar links, on hover" },
  { fg: "--tp-cobalt-700", bg: "--tp-surface", where: "links" },
  { fg: "--tp-cobalt-700", bg: "--tp-cobalt-50", where: "current nav item" },
  { fg: "--tp-on-fill", bg: "--tp-btn", where: "GET method pill" },
  { fg: "--tp-on-fill", bg: "--tp-cobalt", where: "POST method pill" },
  { fg: "--tp-ink-2", bg: "--tp-cobalt-50", where: "metered-cost chip" },
  { fg: "--danger-ink", bg: "--tp-surface", where: "required-parameter annotation" },
  { fg: "--blend-code-label", bg: "--tp-twilight", where: "code panel language label" },
  { fg: "--blend-code-copy", bg: "--tp-twilight", where: "code panel copy control" },
  { fg: "--blend-code-text", bg: "--tp-twilight", where: "code panel sample text" },
];

describe("WCAG 2.2 AA contrast for every pair the app paints", () => {
  for (const { fg, bg, where } of USED_PAIRS) {
    test(`${fg} on ${bg} (${where})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("the math itself", () => {
  // If these two stopped failing, the guard above would be passing vacuously.
  test("catches the pairs that actually shipped broken", () => {
    expect(contrast("--tp-ink-3", "--tp-surface-3")).toBeLessThan(AA_NORMAL);
    expect(contrast("--tp-ink-3", "--nav-hover-fill")).toBeLessThan(AA_NORMAL);
  });

  test("black on white is 21:1", () => {
    expect(contrast("--tp-ink", "--tp-surface")).toBeGreaterThan(15);
  });
});

describe("--tp-ink-4 is never a text colour here", () => {
  // It is the design system's faintest ink — legitimate for placeholders and disabled states elsewhere, but
  // it fails AA against every surface this app paints (2.9:1 even on pure white), and this app is prose.
  function stylesheets(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stylesheets(full, out);
      else if (entry.endsWith(".css")) out.push(full);
    }
    return out;
  }

  test("no stylesheet sets color to --tp-ink-4", () => {
    const offenders = stylesheets(join(import.meta.dir, "..")).filter((file) =>
      /color:\s*var\(--tp-ink-4\)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("and it would indeed fail if used", () => {
    expect(contrast("--tp-ink-4", "--tp-surface")).toBeLessThan(AA_NORMAL);
  });
});
