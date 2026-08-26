// classCoverage.test.ts — every `.tp-ui-*` class a component puts in the DOM must exist in primitives.css.
//
// This exists because of the most expensive defect in the 2026-08 UI audit: nine exported components
// (Button, Input, Label, Alert, Badge, Separator, Checkbox, RadioGroup, RadioOption) were styled with
// Tailwind utility classes, and only apps/auth loads Tailwind. In apps/web, apps/admin and apps/forge those
// class names landed in the DOM with no CSS behind them, so a documented DS component rendered as unstyled
// markup — a raw browser-default button next to a designed one. Nothing could see it: typecheck passes on a
// string, biome passes on a string, and the contrast tests only read CSS that exists. The bug was found by
// reading the four apps' globals.css side by side.
//
// The fix moved those components onto .tp-ui-* classes. This test is what keeps them there: a class that is
// referenced but never defined is exactly the shape of that failure, and it now fails the build instead of
// shipping. It cannot prove a class LOOKS right — only that the styling exists at all, which is the part
// that silently differed per app.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** Class names DEFINED by the stylesheet (any `.tp-ui-foo` appearing in a selector position). */
function definedClasses(): Set<string> {
  const css = readFileSync(join(SRC, "primitives.css"), "utf8")
    // Blank comments so a documented-but-removed class in prose cannot vouch for itself.
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set(Array.from(css.matchAll(/\.(tp-ui-[a-z0-9-]+)/g), (m) => m[1] as string));
}

/** Class names REFERENCED by the components, from string literals and cn() arguments alike. */
function referencedClasses(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of tsxFiles(join(SRC, "components"))) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/["'`](tp-ui-[a-z0-9-]+)["'`]/g)) {
      const name = m[1] as string;
      refs.set(name, [...(refs.get(name) ?? []), file.replace(/\\/g, "/")]);
    }
    // Template-built modifiers, e.g. `tp-ui-btn--${variant}` or `tp-ui-toast--${tone}`. The stem alone is
    // not enough — assert every variant the union can produce (see VARIANT_UNIONS below).
  }
  return refs;
}

/**
 * Classes assembled at runtime from a union type. The regex above sees only the literal prefix, so each
 * union is enumerated here and checked in full — the "success" badge that painted cobalt instead of green
 * was a variant, not a stem.
 */
const VARIANT_UNIONS: Record<string, string[]> = {
  "tp-ui-btn--": ["primary", "secondary", "ghost", "danger", "link"],
  "tp-ui-toast--": ["success", "error"],
  "tp-ui-progress--": ["cobalt", "success", "warning", "danger"],
  "tp-ui-drawer--": ["right", "left"],
  "tp-ui-alert--": ["default", "destructive"],
};

describe("primitives.css covers every class the components use", () => {
  const defined = definedClasses();

  test("the stylesheet parsed (guards against a regex regression passing vacuously)", () => {
    expect(defined.size).toBeGreaterThan(60);
  });

  test("no component references a class the stylesheet does not define", () => {
    const missing: string[] = [];
    for (const [name, files] of referencedClasses()) {
      if (!defined.has(name)) missing.push(`${name}  (${[...new Set(files)].join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  test("every runtime-built variant class exists", () => {
    const missing: string[] = [];
    for (const [stem, variants] of Object.entries(VARIANT_UNIONS)) {
      for (const v of variants) {
        if (!defined.has(`${stem}${v}`)) missing.push(`${stem}${v}`);
      }
    }
    expect(missing).toEqual([]);
  });

  const UTILITY =
    /["'`][^"'`]*\b(?:flex|grid|hidden|h-\d|w-\d|p[xytblr]?-\d|m[xytblr]?-\d|gap-\d|text-(?:xs|sm|base|lg|xl)|bg-(?:white|black|gray|slate)|rounded(?:-\w+)?|border(?:-\d)?|font-(?:medium|semibold|bold)|items-center|justify-\w+|size-\d)\b[^"'`]*["'`]/;

  test("the Tailwind detector would still catch the real thing", () => {
    // Negative controls, taken verbatim from the versions of these files that shipped unstyled outside
    // apps/auth. A checker that cannot fail is worse than no checker: it reads as a guarantee.
    expect(
      UTILITY.test('"h-10 w-full rounded-[var(--radius)] border border-input px-3 text-sm"'),
    ).toBe(true);
    expect(UTILITY.test('"inline-flex items-center gap-2 rounded-full border px-3 py-1"')).toBe(
      true,
    );
    expect(UTILITY.test('"size-4 shrink-0 rounded border-input accent-[var(--tp-cobalt)]"')).toBe(
      true,
    );
    // …and does not fire on the token classes that replaced them.
    expect(UTILITY.test('"tp-ui-btn tp-ui-btn--primary tp-ui-btn--sm"')).toBe(false);
    expect(UTILITY.test('"tp-ui-field tp-ui-field--invalid"')).toBe(false);
  });

  test("no exported component is styled with Tailwind utility classes", () => {
    // The original defect, asserted directly: a utility class in this package only resolves in the one app
    // that loads Tailwind, so the component's appearance depends on which app imported it.
    const offenders: string[] = [];
    for (const file of tsxFiles(join(SRC, "components"))) {
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // Only look inside className={...} / className="..." so prose and data strings cannot trip it.
      for (const m of text.matchAll(/className=\{?([^}\n]*)\}?/g)) {
        if (UTILITY.test(m[1] as string)) {
          offenders.push(`${file.replace(/\\/g, "/")}: ${(m[1] as string).trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
