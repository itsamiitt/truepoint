// migrationShape.test.ts — a cheap structural check on every migration file, runnable without Postgres.
//
// It exists because of a real failure: a migration's own header comment explained the convention by quoting
// the literal breakpoint marker. applyMigrations splits the file on that string, so the comment was cut in
// half and the remainder — starting with the closing backtick — was handed to Postgres as SQL
// ("syntax error at or near `"). Every itest shard failed on a mistake that no typecheck, lint or unit test
// could see, because the file is only ever parsed by a database.
//
// The check below is the local stand-in for that database: split exactly as the migrator does, then assert
// each chunk either is comment-only or begins with something that can actually start a statement.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
/** Must stay identical to applyMigrations' delimiter. */
const BREAKPOINT = ["-->", "statement-breakpoint"].join(" ");

/** Statement-leading keywords used across this repo's hand-authored and generated migrations. */
const STATEMENT_START =
  /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET|GRANT|REVOKE|COMMENT|DO|SELECT|WITH|TRUNCATE|ANALYZE|VACUUM|REASSIGN|SECURITY)\b/i;

/** Strip full-line `--` comments and blank lines — what remains is the actual SQL of the chunk. */
function sqlOf(chunk: string): string {
  return chunk
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("--");
    })
    .join("\n")
    .trim();
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("migration file shape", () => {
  test("there are migrations to check (guards against a silently empty glob)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("every statement chunk is comment-only or starts with a SQL keyword", () => {
    const bad: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      for (const [i, chunk] of content.split(BREAKPOINT).entries()) {
        const sql = sqlOf(chunk);
        if (sql.length === 0) continue; // comment-only or empty — the migrator skips it
        if (!STATEMENT_START.test(sql)) {
          bad.push(`${file} chunk ${i}: ${JSON.stringify(sql.slice(0, 80))}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("no migration quotes the breakpoint marker in its prose", () => {
    // The specific regression: the marker is a literal split token, so a comment containing it is not a
    // comment — it is a statement boundary, and everything after it on that line becomes SQL.
    // Two legitimate placements: the marker alone on its line (hand-authored files), and appended to a
    // statement as `;--> statement-breakpoint` (what drizzle-kit emits). The dangerous one is the marker
    // appearing INSIDE a comment — then the "comment" is really a statement boundary, and whatever follows it
    // on that line is parsed as SQL. Detect that by looking at what precedes the marker: if the prefix has
    // already opened a `--` comment, the marker is inside prose.
    const offenders = files.filter((file) => {
      const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return content.split("\n").some((line) => {
        const at = line.indexOf(BREAKPOINT);
        if (at < 0) return false;
        return line.slice(0, at).trim().startsWith("--");
      });
    });
    expect(offenders).toEqual([]);
  });
});
