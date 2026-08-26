// rawPxBudget.test.ts — bans raw pixel values in inline style objects where a token already covers them.
//
// This is the rule the 2026-08 audit found had drifted furthest: `apps/admin` carried 242 raw spacing values
// against exactly ONE var(--tp-space-*), and apps/web ran about 4:1 the same way. The rule was real and
// written down; nothing checked it, so it decayed like every other unchecked rule in that audit while every
// CHECKED rule sat at 100%.
//
// Half of that was the design system's fault: tokens.css had no type scale at all, so `fontSize` had nothing
// to point at and ~150 raw sizes were the only thing an author COULD write. The --tp-text-* scale closed
// that, and this ratchet is what stops the gap reopening.
//
// Deliberately narrow — it flags a number ONLY when a token holds that exact value:
//   • spacing (gap/padding/margin) matching 4 8 12 16 20 24 32  → --tp-space-1..6, -8
//   • fontSize matching 11 12 13 14 15 16 18 22                  → --tp-text-*
// An off-scale value (5, 26, 28, 260) is a design decision, not a violation, and is not counted. Neither are
// `0`, CSS modules (already token-driven), or width/height/top/left, which are geometry rather than rhythm.
//
// It began as a ratchet, like the --tp-ink-4 one next door. The sweep reached zero, so it is now a plain
// gate — see BUDGET below.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ZERO, not a ratchet count — and that is the interesting part.
 *
 * This started as a ratchet because the number was ~350 across web + admin alone. The sweeps took every app
 * to nought, and the last 27 were inside packages/ui and packages/app-shell themselves. With none left, a
 * budget of 0 turns this from "do not make it worse" into a real gate: the next raw `gap: 16` anywhere in
 * these roots fails the build with the token to use printed beside it.
 *
 * If it ever has to go up, that is a decision to write down here — not a number to bump.
 */
const BUDGET = 0;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ROOTS = [
  "apps/web/src",
  "apps/admin/src",
  "apps/auth/src",
  "apps/forge/src",
  "apps/doc/src",
  "packages/ui/src",
  "packages/app-shell/src",
];

// apps/extension is deliberately absent: a content script runs where tokens.css was never loaded, so it must
// write `var(--token, #fallback)` and its own literal ladder. That is the same carve-out lint-design-tokens
// makes, for the same reason.

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/**
 * Values a token already expresses. A number NOT in here is off-scale and intentionally ignored.
 *
 * The spacing scale is 4 8 12 16 20 24 32 — `--tp-space-1..6` plus `--tp-space-8`. There is no `-7` and
 * NO 40px token: the first version of this list assumed the ladder was regular and included 40, which would
 * have demanded a conversion with nothing to convert to. Two separate sweeps hit that dead end and reported
 * it. Read the scale, don't infer it.
 */
const SPACE_VALUES = new Set([4, 8, 12, 16, 20, 24, 32]);
const TEXT_VALUES = new Set([11, 12, 13, 14, 15, 16, 18, 22]);

/** `gap: 16` / `padding: 8` / `marginTop: 24` — the JS style-object spelling, unquoted number. */
const SPACING_PROP =
  /\b(gap|rowGap|columnGap|padding|margin)(Top|Right|Bottom|Left|Inline|Block)?:\s*(\d+)\b/g;
const FONT_SIZE_PROP = /\bfontSize:\s*(\d+)\b/g;

/** Per-file opt-out, same spelling as the other gates. */
const ALLOW = /raw-px-ok:/;

/**
 * Files where a token CANNOT resolve, so a literal is the only correct answer — the same list, and the same
 * reason, as lint-design-tokens.mjs's EXEMPT_FILES. `global-error.tsx` renders OUTSIDE the root layout and
 * owns its own <html>/<body>, so globals.css — and with it tokens.css — never loads there. Converting these
 * would produce an unstyled crash page, which is the failure the branded page exists to prevent.
 */
const EXEMPT_FILES = new Set([
  "apps/web/src/app/global-error.tsx",
  "apps/admin/src/app/global-error.tsx",
  "apps/forge/src/app/global-error.tsx",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    // .tsx only: this is about inline style objects. CSS modules are already token-driven, and a .ts file
    // holding a style constant is rare enough to catch in review.
    else if (entry.endsWith(".tsx") && !entry.includes(".test.") && !entry.includes(".domtest."))
      out.push(full);
  }
  return out;
}

function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      const relPath = file.slice(REPO.length + 1).replace(/\\/g, "/");
      if (EXEMPT_FILES.has(relPath)) continue;
      const raw = readFileSync(file, "utf8");
      if (ALLOW.test(raw)) continue;
      // Blank comments space-for-space so a documented example cannot be flagged and line numbers survive.
      const text = raw
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/^[^\S\r\n]*\/\/.*$/gm, (m) => " ".repeat(m.length));
      const rel = file.slice(REPO.length + 1).replace(/\\/g, "/");

      for (const m of text.matchAll(SPACING_PROP)) {
        const value = Number(m[3]);
        if (!SPACE_VALUES.has(value)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}: ${m[0]}`);
      }
      for (const m of text.matchAll(FONT_SIZE_PROP)) {
        const value = Number(m[1]);
        if (!TEXT_VALUES.has(value)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}: ${m[0]}`);
      }
    }
  }
  return offenders;
}

describe("raw px where a token exists", () => {
  test("the scan works (guards against a regex regression passing vacuously)", () => {
    // Negative controls: the checker must still recognise the shapes it was written for. A ratchet that
    // silently stops matching reads as "we fixed it all", which is how the --tp-ink-4 scan was wrong twice.
    const sample = "style={{ gap: 16, padding: 8, marginTop: 24, fontSize: 13 }}";
    expect(Array.from(sample.matchAll(SPACING_PROP)).length).toBe(3);
    expect(Array.from(sample.matchAll(FONT_SIZE_PROP)).length).toBe(1);
    // …and must NOT fire on the token form or on off-scale values.
    const clean = 'style={{ gap: "var(--tp-space-4)", padding: 5, fontSize: 26 }}';
    const spacingHits = Array.from(clean.matchAll(SPACING_PROP)).filter((m) =>
      SPACE_VALUES.has(Number(m[3])),
    );
    const textHits = Array.from(clean.matchAll(FONT_SIZE_PROP)).filter((m) =>
      TEXT_VALUES.has(Number(m[1])),
    );
    expect([...spacingHits, ...textHits]).toEqual([]);
  });

  test("no raw px where a token exists", () => {
    const offenders = findOffenders();
    if (offenders.length !== BUDGET) {
      // Print a sample so the failure is actionable rather than just a number.
      process.stderr.write(
        `raw-px ratchet: ${offenders.length} found, BUDGET is ${BUDGET}.\n${offenders
          .slice(0, 25)
          .join("\n")}\n${offenders.length > 25 ? `…and ${offenders.length - 25} more\n` : ""}`,
      );
    }
    expect(offenders.length).toBe(BUDGET);
  });
});
