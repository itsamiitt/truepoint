// primitivesContrast.test.ts — every foreground/background pair the SHARED primitives declare, checked
// against WCAG 2.2 AA by reading the stylesheet rather than by keeping a list.
//
// The per-app contrast tests (apps/doc, apps/web, apps/admin) each hand-enumerate the pairs that app paints,
// which is honest but has a hole: a pair introduced in `primitives.css` lands in EVERY app at once and
// belongs to none of their lists. That is also the highest-leverage place to get it wrong — the failure this
// whole family of tests exists because of (`--tp-ink-3` on `--tp-surface-3`, 4.43:1) was a shared-primitive
// pairing before it was an apps/doc one.
//
// So this one derives its pairs from the CSS. A component added tomorrow with `color: var(--tp-ink-3)` and
// `background: var(--tp-surface-3)` in the same rule fails here without anyone remembering to add a row.
//
// WHAT IT CANNOT SEE, stated plainly so the green is not read as more than it is:
//   • A rule that sets only `color:` — the background comes from an ancestor and CSS cannot tell you which.
//     Those are covered from the other direction by inkFourContrast.test.ts, which ratchets the one token
//     that fails against every surface this product paints.
//   • Composited alpha (`rgba(...)` over a token). apps/doc's test handles its own by asserting pre-computed
//     blends; there are none in primitives.css today.
//   • Anything set in JS/inline styles.
//
// Two rules in here WERE failing when this file was written, both 12px text and both inherited by every app:
// `.tp-ui-field-hint` (the hint under a form field) and `.tp-ui-page-header-eyebrow` (uppercase, wide
// tracking — the least legible shape small text takes). Both were `--tp-ink-4` at 2.54:1; both are now
// `--tp-ink-3`. They are colour-only rules, so this file does not cover them — the ratchet does.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Copied literals from tokens.css — deliberately, so a token change shows up here as a failing pair rather
 *  than as a silently re-derived pass. */
const TOKEN: Record<string, string> = {
  "--tp-ink": "#111827",
  "--tp-ink-2": "#374151",
  "--tp-ink-3": "#6b7280",
  "--tp-ink-4": "#9ca3af",
  "--tp-on-fill": "#ffffff",
  "--tp-surface": "#ffffff",
  "--tp-surface-2": "#f9fafb",
  "--tp-surface-3": "#f4f5f7",
  "--tp-cobalt": "#2563c9",
  "--tp-cobalt-700": "#1e4fa3",
  "--tp-cobalt-50": "#e9f0fc",
  "--nav-hover-fill": "#f3f4f6",
  "--nav-active-fill": "#e8e8e8",
  "--tp-btn": "#111827",
  "--tp-btn-700": "#0b1220",
  "--danger": "#dc2626",
  "--danger-700": "#b91c1c",
  "--danger-tint": "#fef7f7",
  "--danger-50": "#fdeaea",
  "--danger-ink": "#8c5f5f",
  "--success": "#16a34a",
  "--success-700": "#15803d",
  "--warning": "#d97706",
  "--warning-700": "#b45309",
  "--tp-twilight": "#0c0e1a",
};

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

function contrast(fgHex: string, bgHex: string): number {
  const a = luminance(fgHex);
  const b = luminance(bgHex);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;

interface Pair {
  readonly selector: string;
  readonly fg: string;
  readonly bg: string;
}

/**
 * Pull (selector, color, background) out of every rule that declares both.
 *
 * A deliberately small parser, not a CSS engine: split on `}`, take the text after the last `{` as the body
 * and the line before it as the selector. That is exactly true for this stylesheet (flat rules, no nesting)
 * and the pair count is asserted below so a change in shape shows up as a failure rather than as silence.
 */
function declaredPairs(): Pair[] {
  const css = readFileSync(join(import.meta.dir, "primitives.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    " ",
  );
  const pairs: Pair[] = [];
  for (const block of css.split("}")) {
    const brace = block.lastIndexOf("{");
    if (brace < 0) continue;
    const selector = (block.slice(0, brace).split("\n").pop() ?? "").trim();
    const body = block.slice(brace + 1);
    const fg = /(?:^|[;\s])color:\s*var\((--[a-z0-9-]+)\)/.exec(body)?.[1];
    const bg = /background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/.exec(body)?.[1];
    if (fg && bg && TOKEN[fg] && TOKEN[bg]) pairs.push({ selector, fg, bg });
  }
  return pairs;
}

const PAIRS = declaredPairs();

describe("primitives.css — declared fg/bg pairs meet AA", () => {
  test("the parser still finds the rules (a silent zero would pass everything)", () => {
    // 12 when written. A drop means the stylesheet's shape changed and this check went blind, which is the
    // failure mode worth guarding — not the exact number.
    expect(PAIRS.length).toBeGreaterThanOrEqual(10);
  });

  for (const { selector, fg, bg } of PAIRS) {
    test(`${selector} — ${fg} on ${bg}`, () => {
      const ratio = contrast(TOKEN[fg] as string, TOKEN[bg] as string);
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("the check would catch a real regression", () => {
  test("the pairing that started all of this still measures as a failure", () => {
    // --tp-ink-3 on --tp-surface-3 = 4.43:1. If this ever passes, the tokens moved and every "ok" above
    // needs re-reading rather than trusting.
    expect(contrast(TOKEN["--tp-ink-3"] as string, TOKEN["--tp-surface-3"] as string)).toBeLessThan(
      AA_NORMAL,
    );
  });

  test("no rule in primitives.css currently uses that pairing", () => {
    const offenders = PAIRS.filter((p) => p.fg === "--tp-ink-3" && p.bg === "--tp-surface-3");
    expect(offenders).toEqual([]);
  });
});
