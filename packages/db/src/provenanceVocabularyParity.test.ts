// provenanceVocabularyParity.test.ts — pins the @leadwolf/types provenance enums to the CHECK constraints in
// migration 0089. Runs without Postgres.
//
// Why this is worth a test rather than a convention: the two are a belt-and-braces pair, and the failure mode
// of such a pair is silent divergence in the WORSE direction. If the Zod enum gains a member the CHECK does
// not have, every writer using it passes validation and then dies at the database — in the ER path, inside the
// transaction that was also doing the graph write. If the CHECK gains one the Zod enum lacks, the value is
// simply unreachable and the DDL is a lie. Neither shows up in a typecheck, a lint, or any unit test of either
// half on its own.
//
// The comment-stripping below is not incidental. A migration's prose explains its vocabulary by quoting the
// values, so a regex run over the raw file matches words that are documentation, not DDL — the constraint
// would look correct while asserting nothing. Strip full-line comments first, exactly as migrationShape.test.ts
// does for the same class of reason.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  lawfulBasis,
  provenanceAcceptanceState,
  provenanceAction,
  provenanceEntityType,
  provenanceSourceType,
} from "@leadwolf/types";

const MIGRATION = join(import.meta.dir, "migrations", "0089_provenance_event.sql");

/** The migration with every full-line `--` comment removed — what Postgres actually parses. */
function ddlOnly(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** Extract the quoted members of `CONSTRAINT <name> CHECK (<col> IN ('a','b',…))`. */
function checkMembers(constraintName: string): string[] {
  const re = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\([^)]*?IN\\s*\\(([^)]*)\\)`,
    "i",
  );
  const m = ddlOnly().match(re);
  if (!m?.[1]) throw new Error(`CHECK constraint ${constraintName} not found in 0089`);
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .sort();
}

const PAIRS: Array<[string, string, readonly string[]]> = [
  ["entity_type", "provenance_event_entity_type_enum", provenanceEntityType.options],
  ["action", "provenance_event_action_enum", provenanceAction.options],
  ["source_type", "provenance_event_source_type_enum", provenanceSourceType.options],
  ["lawful_basis", "provenance_event_lawful_basis_enum", lawfulBasis.options],
  ["acceptance_state", "provenance_event_acceptance_enum", provenanceAcceptanceState.options],
];

describe("provenance vocabulary parity (types ↔ migration 0089)", () => {
  for (const [column, constraint, zodOptions] of PAIRS) {
    test(`${column}: the Zod enum and the CHECK constraint hold the same members`, () => {
      expect(checkMembers(constraint)).toEqual([...zodOptions].sort());
    });
  }

  test("the extraction actually found something (guards a regex that silently matches nothing)", () => {
    // A parity test whose extractor returns [] on both sides passes while asserting nothing at all — the same
    // failure class as a guard that cannot fire. Assert the shapes are non-trivial.
    for (const [, constraint] of PAIRS) {
      expect(checkMembers(constraint).length).toBeGreaterThan(1);
    }
  });

  test("comment stripping is load-bearing — the raw file does mention values outside the CHECKs", () => {
    // If this ever stops being true the stripping is merely harmless rather than necessary, and the note at the
    // top of this file should be softened. Today the prose names vocabulary members in several places.
    const raw = readFileSync(MIGRATION, "utf8");
    const commentLines = raw.split("\n").filter((l) => l.trim().startsWith("--"));
    expect(commentLines.some((l) => /'[a-z_]+'/.test(l))).toBe(true);
  });
});
