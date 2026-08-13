// arrayParamBinding.test.ts — pins how JS arrays reach Postgres from a raw `sql` template.
//
// WHY THIS EXISTS. Drizzle's sql template SPREADS a plain JS array into one bind per element, so
// `ANY(${ids})` renders as `ANY(($1, $2))` — a ROW CONSTRUCTOR, not an array — and a text[] insert receives
// the bare element instead of the array. Postgres then fails at runtime with 22P02 ("malformed array literal
// … Array value must start with {"). Nothing upstream catches it: the types are correct, biome is happy, and
// no unit test touches SQL text, so it surfaces only against a real database — for us, only in CI, twenty
// minutes per attempt. It cost three round-trips on migration 0108's repositories.
//
// This test closes that gap WITHOUT a database. PgDialect renders a query and its parameters offline, so the
// binding shape can be asserted directly. A regression fails here, on a laptop, in milliseconds.
//
// The rule it encodes: pass an array through `sql.param(value)` and cast it, or hand-build the '{a,b}' literal
// (dsarRepository's documented approach, fine for uuids). Never interpolate a bare JS array.

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Tx } from "../client.ts";
import { recordEducation } from "./masterEducationRepository.ts";
import { listCreatorsForTechnologies } from "./masterTechnologyRepository.ts";

const dialect = new PgDialect();

/** A Tx that runs nothing: it captures the query it was handed so the SQL can be rendered offline. */
function capturingTx(): { tx: Tx; rendered: () => { sql: string; params: unknown[] } } {
  let captured: Parameters<typeof dialect.sqlToQuery>[0] | undefined;
  const tx = {
    execute: (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
      captured = q;
      return Promise.resolve([] as unknown[]);
    },
  } as unknown as Tx;
  return {
    tx,
    rendered: () => {
      if (!captured) throw new Error("no query was executed");
      const q = dialect.sqlToQuery(captured);
      return { sql: q.sql, params: q.params as unknown[] };
    },
  };
}

describe("the hazard itself (why the rule exists)", () => {
  test("a BARE array is spread into one bind per element — a row constructor, not an array", () => {
    const q = dialect.sqlToQuery(sql`SELECT 1 WHERE x = ANY(${["a", "b"]}::uuid[])`);
    expect(q.sql).toContain("($1, $2)");
    expect(q.params).toEqual(["a", "b"]);
  });

  test("sql.param binds the whole array as ONE parameter", () => {
    const q = dialect.sqlToQuery(sql`SELECT 1 WHERE x = ANY(${sql.param(["a", "b"])}::uuid[])`);
    expect(q.sql).toContain("$1::uuid[]");
    expect(q.sql).not.toContain("$2");
    expect(q.params).toEqual([["a", "b"]]);
  });
});

describe("listCreatorsForTechnologies", () => {
  test("binds the id list as a single uuid[] parameter", async () => {
    const { tx, rendered } = capturingTx();
    await listCreatorsForTechnologies(tx, ["id-1", "id-2"]);
    const { sql: text, params } = rendered();

    expect(text).toContain("ANY($1::uuid[])");
    // The spread form would produce a second placeholder for the second id.
    expect(text).not.toContain("($1, $2)");
    expect(params).toEqual([["id-1", "id-2"]]);
  });
});

describe("recordEducation", () => {
  test("binds fields_of_study as a single text[] parameter (resolved-school branch)", async () => {
    const { tx, rendered } = capturingTx();
    await recordEducation(tx, {
      masterPersonId: "p-1",
      masterCompanyId: "c-1",
      // Two entries, and one containing a comma — the case a hand-built '{a,b}' literal would corrupt.
      fieldsOfStudy: ["Computer Science", "Mathematics, Applied"],
      startedOn: "2015-08-01",
    });
    const { params } = rendered();

    expect(params).toContainEqual(["Computer Science", "Mathematics, Applied"]);
    // The bug shipped to CI three times looked exactly like this: the element, not the array.
    expect(params).not.toContainEqual("Computer Science");
  });

  test("binds fields_of_study the same way on the unresolved-school branch", async () => {
    const { tx, rendered } = capturingTx();
    await recordEducation(tx, {
      masterPersonId: "p-1",
      masterCompanyId: null,
      schoolNameNormalized: "some school",
      fieldsOfStudy: ["History"],
      startedOn: "2015-08-01",
    });
    const { params } = rendered();

    expect(params).toContainEqual(["History"]);
    expect(params).not.toContainEqual("History");
  });

  test("an absent fields_of_study still binds a single null, not a spread", async () => {
    const { tx, rendered } = capturingTx();
    await recordEducation(tx, {
      masterPersonId: "p-1",
      masterCompanyId: "c-1",
      startedOn: "2015-08-01",
    });
    const { sql: text, params } = rendered();

    expect(text).toContain("::text[]");
    expect(params).toContain(null);
  });
});
