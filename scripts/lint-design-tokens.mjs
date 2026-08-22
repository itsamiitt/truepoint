#!/usr/bin/env node
// lint-design-tokens.mjs — a raw hex colour is a token that stopped tracking the design system.
//
// truepoint-design's first rule is "No hardcoded hex: #2563c9 → var(--tp-cobalt)", and its own implementation
// note says the rule is "enforced by code review against the Brand Kit + tokens.css" because no design lint
// exists. Code review is exactly the enforcement mechanism this repo has already watched fail three times
// (the itest `.rejects` shape, the armed production switch, the committed credential), each of which is now a
// script in this directory. This is the same move for the cheapest design rule to check mechanically.
//
// The cost of a stray hex is not aesthetic. `--tp-cobalt` moving means every surface follows; a `#2563c9`
// frozen into a stylesheet does not, and the drift is invisible until someone screenshots two pages side by
// side. Worse for the dark/tinted surfaces, where the token pairs are what contrast.test.ts asserts — a raw
// hex is outside that check by construction, so it can fail AA silently.
//
// DELIBERATELY NARROW, because a design lint that cries wolf gets deleted faster than any other kind. Only a
// hex used as a COLOUR VALUE counts:
//   • .css  — in a declaration value (`color: #fff`), which is where a real one always is.
//   • .tsx  — in a colour-ish context (a style object, a fill/stroke/background prop).
// Everything else is left alone, and each exclusion below is a real case from this codebase, not a
// hypothetical:
//   • `packages/ui/src/tokens.css` — the definitions. The one file whose whole job is raw hex.
//   • `var(--tp-ink, #111827)` — a token WITH its fallback. apps/extension does this deliberately: a content
//     script runs in a page that never loaded tokens.css, so the fallback is what makes the token safe there.
//     Flagging it would push the fix in exactly the wrong direction.
//   • `themeColor: "#2563C9"` — Next's Viewport metadata is serialised into a <meta> tag before any
//     stylesheet exists. `var()` is not a legal value there; a literal is the only correct answer.
//   • comments — `/* over #0c0e1a needs ≥0.55 */` is prose ABOUT a colour, and the contrast reasoning in
//     prose.module.css is worth more than the rule.
//   • `placeholder="…credit for incident #123…"` — `#123` is a valid 3-digit hex and an issue number. This is
//     why the check demands a colour context rather than matching hex shapes anywhere.
//
// Escape hatch, on the line above or within three lines:
//   // design-tokens-ok: <why this must be a literal>      (or the /* */ form in CSS)
//
// Run: `node scripts/lint-design-tokens.mjs` (wired as `bun run lint:design-tokens`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/** The definitions themselves. */
const EXEMPT_FILES = ["packages/ui/src/tokens.css"];

const HEX = String.raw`#[0-9a-fA-F]{3,8}\b`;

/** A CSS declaration whose value carries a hex: `color: #fff`, `border: 1px solid #eee`. */
const CSS_DECLARATION = new RegExp(String.raw`^\s*[-a-zA-Z]+\s*:\s*[^;]*${HEX}`);

/** A hex in a colour-ish position in JSX/TS — a style object entry or a colour-carrying prop. */
const JSX_COLOUR = new RegExp(
  String.raw`(color|colour|background|border|fill|stroke|shadow|outline)[^\n]{0,40}["']${HEX}`,
  "i",
);

const ALLOW = /design-tokens-ok:/;

/** Next's Viewport metadata: serialised to <meta> before any stylesheet loads, so var() cannot work. */
const METADATA_LITERAL = /themeColor/;

function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".css") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Blank out what must not be matched, WITHOUT changing line numbers — comments are replaced space-for-space
 * so a reported line still points where a human will look.
 */
function stripNonColour(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (match) => " ".repeat(match.length))
    .replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, (match) =>
      " ".repeat(match.length),
    );
}

const offenders = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const posix = file.split(sep).join("/");
    if (EXEMPT_FILES.includes(posix)) continue;
    scanned += 1;

    const raw = readFileSync(file, "utf8");
    if (ALLOW.test(raw) === false && !new RegExp(HEX).test(raw)) continue;

    const lines = stripNonColour(raw).split("\n");
    const rawLines = raw.split(/\r?\n/);
    const isCss = posix.endsWith(".css");

    lines.forEach((line, index) => {
      if (METADATA_LITERAL.test(line)) return;
      if (!(isCss ? CSS_DECLARATION.test(line) : JSX_COLOUR.test(line))) return;
      // A declared exception within the three lines above — same lookback as the secrets scanner, and for the
      // same reason: the match often lands on a continuation line, below where a human put the note.
      if (rawLines.slice(Math.max(0, index - 3), index + 1).some((l) => ALLOW.test(l))) return;
      offenders.push(`${posix}:${index + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
}

if (offenders.length === 0) {
  process.stdout.write(`ok   ${scanned} stylesheets and components, no raw hex colours\n`);
  process.exit(0);
}

process.stdout.write(
  `${offenders.length} raw hex colour(s):

${offenders.join("\n")}

A hex frozen into a stylesheet stops tracking the design system: moving --tp-cobalt moves every surface that
uses the token and none that hardcoded its value, and the drift only shows up when someone compares two pages.
It also sits outside apps/doc's contrast.test.ts, which asserts TOKEN pairs — so a raw hex can fail WCAG AA
without anything noticing.

Use the token: #2563c9 → var(--tp-cobalt), #fff on a filled control → var(--tp-on-fill).
packages/ui/src/tokens.css is the full list.

If a literal is genuinely required — a <meta> colour, a canvas/SVG value with no cascade — say why:
  // design-tokens-ok: <reason>
`,
);
process.exit(1);
