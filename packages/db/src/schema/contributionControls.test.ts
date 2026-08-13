// contributionControls.test.ts — pin the TypeScript definitions against the SQL that actually shipped.
//
// These three tables were created by hand-authored SQL in migration 0097 and had no `pgTable` at all until
// now, so nothing compared the two. A hand-authored table with a hand-written repository is drift waiting to
// happen: rename a column in the migration and the only thing that notices is a query failing in production.
//
// This is a UNIT test — it reads the migration file as text and checks the definitions agree on the things
// that break silently: column names, the CHECK constraints that enforce consent attribution and the deny-list
// target rule, and the partial uniques. It deliberately does NOT need a database. The stronger check (running
// DDL and diffing information_schema) belongs in an itest; this one runs on every commit, which is where drift
// is cheapest to catch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contributionExclusion,
  contributionPolicy,
  crmObjectContribution,
} from "./contributionControls.ts";

const MIGRATION = readFileSync(
  join(import.meta.dir, "../migrations/0097_contribution_controls.sql"),
  "utf8",
);

/** Column names the Drizzle definition claims, in SQL form. */
function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.map((c) => c.name)
    .sort();
}

describe("contribution_policy", () => {
  test("every declared column exists in the shipped DDL", () => {
    for (const name of columnNames(contributionPolicy)) {
      expect(MIGRATION).toContain(name);
    }
  });

  test("workspace_id is the primary key — one policy per workspace, enforced by shape", () => {
    const cfg = getTableConfig(contributionPolicy);
    const pkCols = cfg.columns.filter((c) => c.primary).map((c) => c.name);
    expect(pkCols).toEqual(["workspace_id"]);
    expect(MIGRATION).toContain("workspace_id       uuid PRIMARY KEY");
  });

  test("an enabled policy must name who enabled it — the consent CHECK is present on both sides", () => {
    // Consent with no actor is not a consent record. If this constraint is ever dropped from the migration,
    // this test is what says so.
    expect(MIGRATION).toContain("contribution_policy_enabled_is_attributed");
    const checks = getTableConfig(contributionPolicy).checks.map((c) => c.name);
    expect(checks).toContain("contribution_policy_enabled_is_attributed");
  });
});

describe("contribution_exclusion", () => {
  test("every declared column exists in the shipped DDL", () => {
    for (const name of columnNames(contributionExclusion)) {
      expect(MIGRATION).toContain(name);
    }
  });

  test("the target CHECK is present — a deny list that fails OPEN is worse than none", () => {
    expect(MIGRATION).toContain("contribution_exclusion_target");
    const checks = getTableConfig(contributionExclusion).checks.map((c) => c.name);
    expect(checks).toContain("contribution_exclusion_target");
    expect(checks).toContain("contribution_exclusion_kind_enum");
  });

  test("all three partial uniques are declared — one composite would let NULLs defeat it", () => {
    for (const name of [
      "uniq_contribution_exclusion_domain",
      "uniq_contribution_exclusion_account",
      "uniq_contribution_exclusion_contact",
    ]) {
      expect(MIGRATION).toContain(name);
    }
  });
});

describe("crm_object_contribution", () => {
  test("every declared column exists in the shipped DDL", () => {
    for (const name of columnNames(crmObjectContribution)) {
      expect(MIGRATION).toContain(name);
    }
  });

  test("the composite primary key is (connection_id, object_type)", () => {
    expect(MIGRATION).toContain("PRIMARY KEY (connection_id, object_type)");
  });

  test("object_type is CHECK-constrained, not an FK to crm_field_mappings", () => {
    // Deliberate: a customer may exclude an object they have not mapped a single field of yet.
    expect(MIGRATION).toContain("crm_object_contribution_object_enum");
    const checks = getTableConfig(crmObjectContribution).checks.map((c) => c.name);
    expect(checks).toContain("crm_object_contribution_object_enum");
  });
});

describe("the barrel exclusion is deliberate", () => {
  test("this module is NOT re-exported from schema/index.ts", () => {
    // drizzle.config.ts points at that barrel. If these tables become visible to drizzle-kit, `generate`
    // will start emitting competing DDL for hand-authored tables — the exact failure the 0101/0103/0108
    // headers warn about.
    const barrel = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(barrel).not.toContain("contributionControls");
  });
});
