// listCaps.test.ts — the configuration-list reads must stay bounded (audit 32 · C6).
//
// This reads the repository SOURCE rather than running a query, deliberately. What broke here was not a
// wrong result — every one of these reads was correct — it was the absence of a LIMIT, so the failure only
// appears on a workspace large enough to hurt, which is exactly the workspace where you cannot afford to
// discover it. A source-level assertion catches the regression at the moment someone writes the next
// unbounded list, on a laptop, in milliseconds, with no database.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_SAFETY_CAP } from "./listCaps.ts";

/** Every read that returns a whole workspace-configuration collection, and the function that does it. */
const BOUNDED_READS: ReadonlyArray<readonly [file: string, fn: string]> = [
  ["tagRepository.ts", "listByWorkspace"],
  ["pipelineStageRepository.ts", "list"],
  ["savedSearchRepository.ts", "listVisible"],
  ["customFieldRepository.ts", "listDefinitionsByEntity"],
  ["workspaceRepository.ts", "listForUser"],
  ["crmConnectionRepository.ts", "listByWorkspace"],
];

/** The body of one method, from its declaration to the start of the next one. */
function methodBody(file: string, fn: string): string {
  const src = readFileSync(join(import.meta.dir, file), "utf8");
  const start = src.indexOf(`async ${fn}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}(?:async )?\w+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("workspace-configuration lists are bounded", () => {
  for (const [file, fn] of BOUNDED_READS) {
    test(`${file.replace(".ts", "")}.${fn} applies the safety cap`, () => {
      expect(methodBody(file, fn)).toContain("LIST_SAFETY_CAP");
    });
  }

  test("the cap is a ceiling, not a page size", () => {
    // If this ever needs raising, the honest fix is a paginated surface — see the constant's own note.
    // Pinned so lowering it into page-size territory is a conscious edit rather than a tweak.
    expect(LIST_SAFETY_CAP).toBe(1000);
    expect(LIST_SAFETY_CAP).toBeGreaterThan(100);
  });
});
