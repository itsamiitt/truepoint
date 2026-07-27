// migrationTolerance.test.ts — pins WHICH failures the migrator is allowed to skip.
//
// This matters more than its size suggests. applyMigrations is forward-only with no `down`, and it records the
// hash row LAST — so a statement that is wrongly skipped leaves a database that is half-migrated *and* marked
// applied, which no later run will fix. Tolerance therefore has to be limited to errors where skipping the
// statement leaves exactly the state the statement intended: DDL "this object already exists".
//
// The specific regression guarded here: 23505 (unique_violation) used to be tolerated, annotated "idempotent
// seed rows". It is a DATA error, so tolerating it swallowed genuine integrity conflicts in ANY statement of ANY
// migration. Seeds are made idempotent with ON CONFLICT in the SQL instead — visible where it applies.

import { describe, expect, test } from "bun:test";
import { isTolerableMigrationError } from "./applyMigrations.ts";

describe("migration error tolerance", () => {
  test("tolerates the DDL already-exists codes (a replayed lineage re-creates existing objects)", () => {
    for (const code of [
      "42P07", // duplicate_table
      "42710", // duplicate_object — constraint, trigger, role
      "42701", // duplicate_column
      "42P06", // duplicate_schema
      "42723", // duplicate_function
    ]) {
      expect(isTolerableMigrationError(code)).toBe(true);
    }
  });

  test("does NOT tolerate unique_violation — a data conflict must abort, not be skipped", () => {
    // If this ever flips back to true, a failed backfill row silently disappears and the migration is still
    // recorded as applied.
    expect(isTolerableMigrationError("23505")).toBe(false);
  });

  test("does NOT tolerate the other data/consistency failures", () => {
    for (const code of [
      "23503", // foreign_key_violation
      "23502", // not_null_violation
      "23514", // check_violation
      "25001", // active_sql_transaction — what a CONCURRENTLY index build hits inside a transaction
      "57014", // query_canceled — a statement_timeout kill mid-build
      "42501", // insufficient_privilege
      "42P01", // undefined_table — the "silently never applied" symptom this migrator exists to prevent
      "42804", // datatype_mismatch
    ]) {
      expect(isTolerableMigrationError(code)).toBe(false);
    }
  });

  test("an error with no SQLSTATE is never tolerated", () => {
    // A connection drop or a driver-level failure carries no code; skipping those would be silent data loss.
    expect(isTolerableMigrationError(undefined)).toBe(false);
    expect(isTolerableMigrationError("")).toBe(false);
  });
});
