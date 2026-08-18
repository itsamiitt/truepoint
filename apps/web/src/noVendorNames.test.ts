// noVendorNames.test.ts — a STRUCTURAL guard (Layer-0-as-database plan, slice 7 [S-10]): no upstream data
// vendor may be named in customer-facing surfaces. Which provider the platform buys from is a commercial
// detail that changes without the customer; naming it makes every provider swap a UI migration, and tells
// every prospect exactly which database to opt out of.
//
// The rule is enforced here rather than by review because the leak is always incidental — a raw enum
// rendered straight into JSX, a hardcoded "Refresh from <vendor>". Confidence is still expressed honestly,
// as a SOURCE COUNT, which names nobody.
//
// SCOPE: the customer web app + the extension. NOT apps/admin or apps/forge (staff consoles legitimately
// name providers — that is the whole point of the Data sources console), and not tests/fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  join(import.meta.dir, ".."), // apps/web/src
  join(import.meta.dir, "..", "..", "..", "extension", "src"),
];

const BANNED =
  /\b(apollo|zoominfo|clearbit|coresignal|people data labs)\b|linkedin data api|from linkedin|linkedin refresh/i;

/** The user's OWN declared import sources are their words about their file, not us naming our vendor. */
const ALLOWED_FILES = new Set([
  "types.ts", // import wizard source picklist + settings-billing labels are checked by their own review
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield p;
    }
  }
}

describe("customer surfaces never name a data vendor", () => {
  test("no banned vendor string in apps/web or apps/extension source", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const base = file.split(/[\\/]/).pop() as string;
        if (ALLOWED_FILES.has(base)) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          // Only flag STRING/JSX content, not import paths or identifiers like `linkedinPublicId`.
          if (!BANNED.test(line)) return;
          if (/^\s*(import|export)\s/.test(line)) return;
          // Comments never render — the rule is about what a CUSTOMER can read on screen. This covers
          // line comments, block-comment bodies, and JSX `{/* … */}` comments.
          if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
          offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
