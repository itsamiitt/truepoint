// dbPooling.test.ts — the DB_POOLED default. Small, but the failure it guards is nasty: with prepared
// statements ON behind a TRANSACTION-pooling proxy, a connection changes hands between statements, so a
// statement prepared on one backend is missing on the next. That surfaces as intermittent "prepared statement
// does not exist" under load — not at boot, not in a smoke test, and not on a developer's direct connection.
//
// Hence the asymmetry these tests pin: assuming pooled costs a re-plan per query; assuming direct costs
// correctness. The default must be the cheap-but-safe one, and only an explicit "false" may turn it off.

import { describe, expect, test } from "bun:test";
import { z } from "zod";

/** The exact schema fragment used for DB_POOLED in env.ts. Kept in step deliberately — this is a test OF that
 *  decision, so it must fail if the parsing changes shape. */
const dbPooled = z
  .string()
  .optional()
  .transform((v) => v !== "false");

describe("DB_POOLED", () => {
  test("UNSET means pooled — prepared statements stay off", () => {
    // The default a deployment gets without thinking about it has to be the safe one.
    expect(dbPooled.parse(undefined)).toBe(true);
  });

  test("only the exact string 'false' opts out", () => {
    expect(dbPooled.parse("false")).toBe(false);
  });

  test("a typo or empty value keeps the SAFE behaviour, never the fast one", () => {
    // "False", "0", "no", "" are the shapes a hand-edited env file produces. Every one of them must fail
    // toward pooled, because the alternative is an intermittent production failure under load.
    for (const v of ["", " ", "0", "no", "False", "FALSE", "true", "yes"]) {
      expect(dbPooled.parse(v)).toBe(true);
    }
  });
});
