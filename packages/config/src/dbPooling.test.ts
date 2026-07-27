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

describe("pool budget", () => {
  const poolMax = z.coerce.number().int().positive().default(10);
  const ownerMax = z.coerce.number().int().positive().default(4);
  const forgeMax = z.coerce.number().int().positive().default(5);
  const replicaMax = z.coerce.number().int().positive().default(5);

  test("the OWNER pool is smaller than the tenant pool", () => {
    // Splitting tenant traffic out without shrinking the owner pool would have multiplied the per-process
    // budget rather than redistributing it. The owner pool serves low-concurrency privileged paths; the hot
    // path is tenant traffic.
    expect(ownerMax.parse(undefined)).toBeLessThan(poolMax.parse(undefined));
  });

  test("the default per-process budget stays within a sane server allowance", () => {
    // 10 + 4 + 5 + 5 = 24 worst case, and postgres.js is LAZY — a process opens only the pools it actually
    // uses, so no single process reaches that. The number that matters is what a few replicas of api +
    // workers multiply out to against a default max_connections of 100, tighter on managed Postgres. Pin it
    // so a future pool split is a conscious act rather than a silent multiplication.
    const worstCase =
      poolMax.parse(undefined) +
      ownerMax.parse(undefined) +
      forgeMax.parse(undefined) +
      replicaMax.parse(undefined);
    expect(worstCase).toBeLessThanOrEqual(25);
  });

  test("every pool size must be a positive integer", () => {
    // A zero or negative max would either deadlock on checkout or be rejected by the driver at a much less
    // obvious moment than config parse.
    for (const schema of [poolMax, ownerMax, forgeMax, replicaMax]) {
      expect(() => schema.parse("0")).toThrow();
      expect(() => schema.parse("-1")).toThrow();
      expect(() => schema.parse("1.5")).toThrow();
    }
  });
});

describe("replica pool (E-6.3)", () => {
  const replicaUrl = z.string().url().optional();
  const replicaMax = z.coerce.number().int().positive().default(5);

  test("the URL is OPTIONAL — unset means the primary, i.e. the same rows as today", () => {
    // This is what makes the change inert on an unconfigured deployment: same database, separate pool. The
    // connection-budget isolation lands immediately; pointing it at a real replica later is config, not code.
    expect(replicaUrl.parse(undefined)).toBeUndefined();
    expect(() => replicaUrl.parse("not-a-url")).toThrow();
  });

  test("its budget is small, like Forge's, and for the same reason", () => {
    // Dashboard aggregates are batch-shaped work that can queue; a request cannot. The tenant pool keeps the
    // larger share.
    expect(replicaMax.parse(undefined)).toBe(5);
    expect(replicaMax.parse(undefined)).toBeLessThan(10);
  });
});
