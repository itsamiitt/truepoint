// migrationSeedLengths.test.ts — every feature_flags seed INSERT in the migration files must fit the
// column it targets. feature_flags.description is varchar(500) (schema/featureFlags.ts); a longer seed
// value fails the WHOLE production migration run with the bare "value too long for type character
// varying(500)" — no file name, no key — exactly the failure that blocked the first prod deploy
// (migrations 0059–0069 carried 551–1012-char descriptions, written on machines that could never run
// them). Pure static scan: no database needed, so it runs anywhere `bun test` does.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");
const DESCRIPTION_MAX = 500;

/** Single-quoted SQL literals on a line, with '' unescaped to '. */
function literalsOn(line: string): string[] {
  return [...line.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"));
}

describe("feature_flags seed migrations", () => {
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  test("every seeded description fits varchar(500)", () => {
    const violations: string[] = [];
    for (const file of sqlFiles) {
      const lines = readFileSync(join(migrationsDir, file), "utf8").split("\n");
      for (const line of lines) {
        if (!/INSERT INTO\s+"?feature_flags"?/i.test(line)) continue;
        // Column order in every seed: (key, description, global_enabled, "default") — literal #1 is
        // the key, #2 the description. A future seed with a different shape trips the sanity check below.
        const literals = literalsOn(line);
        if (literals.length < 2) {
          violations.push(`${file}: feature_flags INSERT with <2 string literals — update this test's parser`);
          continue;
        }
        const [key, description] = literals;
        if (description.length > DESCRIPTION_MAX) {
          violations.push(
            `${file}: flag "${key}" description is ${description.length} chars (max ${DESCRIPTION_MAX})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
