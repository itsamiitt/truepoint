// gridColumns.test.ts — the results-grid column registries for both Search panes.
//
// These guard the class of defect that shipped the duplicate "Email" header: two columns carrying the same
// label, a chooser entry for a column that is actually always-on, or a default set naming a key the chooser
// does not offer. The registries are pure data (see columnRegistry.ts on why they are separate from the
// builders), so this needs no DOM and no `@/…` alias resolution.

import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_ALWAYS_ON_COLUMNS,
  ACCOUNT_DEFAULT_VISIBLE_COLUMNS,
  ACCOUNT_TOGGLEABLE_COLUMNS,
  PEOPLE_ALWAYS_ON_COLUMNS,
  PEOPLE_DEFAULT_VISIBLE_COLUMNS,
  PEOPLE_TOGGLEABLE_COLUMNS,
  type ToggleableColumn,
} from "./columnRegistry.ts";

/** The invariants both grids must hold, asserted against each registry in turn. */
function assertRegistry(
  toggleable: ToggleableColumn[],
  defaults: string[],
  alwaysOn: string[],
): void {
  const keys = toggleable.map((c) => c.key);
  const labels = toggleable.map((c) => c.label);

  // A duplicate key would make the chooser toggle two columns at once.
  expect(new Set(keys).size).toBe(keys.length);
  // A duplicate LABEL is the shipped bug: the grid had two columns headed "Email", one of them called
  // "Address" in the chooser, so neither the header nor the menu identified which was which.
  expect(new Set(labels).size).toBe(labels.length);
  // Every default must be something the chooser can turn back on, or the user can hide a column for good.
  for (const key of defaults) expect(keys).toContain(key);
  // An always-on column offered in the chooser would render a toggle that changes nothing.
  for (const key of alwaysOn) expect(keys).not.toContain(key);
  // Empty labels render a blank checkbox row.
  for (const col of toggleable) expect(col.label.trim().length).toBeGreaterThan(0);
}

describe("people column registry", () => {
  test("holds the shared registry invariants", () => {
    assertRegistry(
      PEOPLE_TOGGLEABLE_COLUMNS,
      PEOPLE_DEFAULT_VISIBLE_COLUMNS,
      PEOPLE_ALWAYS_ON_COLUMNS,
    );
  });

  test("exposes the masked fields the grid used to drop on the floor", () => {
    const keys = PEOPLE_TOGGLEABLE_COLUMNS.map((c) => c.key);
    // Each of these is on MaskedContact and had no way to reach the screen before.
    for (const key of [
      "seniority",
      "department",
      "location",
      "outreach",
      "lineType", // [S-04] mobile-vs-landline, pre-reveal
      "health", // [S-10] data health
      "verified", // [S-10] verification recency
      "created",
    ])
      expect(keys).toContain(key);
  });

  test("the two email columns are named apart", () => {
    const byKey = new Map(PEOPLE_TOGGLEABLE_COLUMNS.map((c) => [c.key, c.label]));
    expect(byKey.get("email")).toBe("Email status");
    expect(byKey.get("address")).toBe("Email");
  });
});

describe("account column registry", () => {
  test("holds the shared registry invariants", () => {
    assertRegistry(
      ACCOUNT_TOGGLEABLE_COLUMNS,
      ACCOUNT_DEFAULT_VISIBLE_COLUMNS,
      ACCOUNT_ALWAYS_ON_COLUMNS,
    );
  });

  test("exposes the MaskedAccount fields the grid used to drop on the floor", () => {
    const keys = ACCOUNT_TOGGLEABLE_COLUMNS.map((c) => c.key);
    for (const key of ["subIndustry", "location", "technologies", "founded", "icp"])
      expect(keys).toContain(key);
  });
});
