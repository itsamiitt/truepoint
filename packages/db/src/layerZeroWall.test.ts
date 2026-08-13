// layerZeroWall.test.ts — the Layer-0 grant-off wall must keep naming the tables it protects.
//
// WHY THIS EXISTS. Layer 0 (the shared master graph) has NO tenant column, so it cannot have an RLS predicate.
// Its isolation is structural: `applyMigrations` REVOKEs it from `leadwolf_app`, and the customer role
// therefore cannot address it at all. PLAN_04/PLAN_07 call that "grant-off is the wall".
//
// Two mechanisms hold it, and they are not equally safe:
//   • a `^master_` catch-all loop, which covers any FUTURE table named master_* automatically;
//   • an EXPLICIT list, which is the only thing covering the Layer-0 tables that are NOT named master_* —
//     source_records, match_links, projection_outbox, provenance_event.
//
// applyMigrations says so itself: "Tables NOT matching master_* … still rely on the explicit list above; each
// phase MUST add its system-owned tables there." A MUST with nothing enforcing it. Delete a name from that
// list and `leadwolf_app` silently regains DML on a Layer-0 table — provenance_event carries `contributor_ref`,
// the C-02 wall, so the blast radius includes contributor identity.
//
// The isolation itests do check the wall at runtime, but they need Postgres, and on a host without Docker that
// means the check only happens in CI. This one runs on a laptop in milliseconds, which is where an accidental
// edit to that list actually gets made.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "applyMigrations.ts"), "utf8");

/**
 * Layer-0 tables NOT named `master_*`, so the catch-all cannot reach them.
 *
 * This list is the point of the test. If a phase adds a system-owned Layer-0 table that is not master_-prefixed,
 * add it here AND to the REVOKE in applyMigrations — the two must move together, which is exactly what nothing
 * previously enforced.
 */
const NON_MASTER_LAYER_ZERO = [
  "source_records",
  "match_links",
  "projection_outbox",
  "provenance_event",
] as const;

describe("the Layer-0 grant-off wall", () => {
  test("applyMigrations still REVOKEs every non-master_ Layer-0 table from leadwolf_app", () => {
    // Scoped to REVOKE statements naming leadwolf_app, so a passing mention in a comment cannot satisfy it.
    const revokes = [...src.matchAll(/REVOKE\s+ALL\s+ON\s+([\s\S]*?)FROM\s+leadwolf_app/gi)]
      .map((m) => m[1] as string)
      .join(" ");

    for (const table of NON_MASTER_LAYER_ZERO) {
      expect(revokes).toContain(table);
    }
  });

  test("the ^master_ catch-all loop is still present", () => {
    // The other half of the wall. It is what makes a NEW master_* table fail closed by default, and it is a
    // loop over pg_tables rather than a list — easy to delete during a refactor and invisible when gone,
    // because nothing named in it would appear to be missing.
    expect(src).toMatch(/tablename\s*~\s*'\^master_'/);
    expect(src).toMatch(/REVOKE ALL ON public\.%I FROM leadwolf_app/);
  });

  test("leadwolf_er keeps SELECT/INSERT/UPDATE and is never granted DELETE on Layer 0", () => {
    // The resolver role reads and mints; erasure is the audited owner/withPrivilegedTx path. A DELETE grant
    // here would silently move a compliance-critical operation onto an unaudited connection.
    // `[^;]` matters: without it the match runs across statement boundaries and picks up the DELETE from the
    // leadwolf_app grant several lines earlier, failing on correct code. A statement ends at its semicolon,
    // so confining the match to one is what makes this assertion about leadwolf_er at all.
    const erGrants = [...src.matchAll(/GRANT\s+([A-Z,\s]+?)\s+ON\s+[^;]*?TO\s+leadwolf_er/gi)].map(
      (m) => (m[1] as string).toUpperCase(),
    );
    expect(erGrants.length).toBeGreaterThan(0);
    for (const g of erGrants) {
      expect(g).not.toContain("DELETE");
    }
  });

  test("the app role is never granted anything on a master_ table", () => {
    // A GRANT naming leadwolf_app and a master_ table in the same statement would defeat the wall from the
    // other direction — the catch-all REVOKE runs once at migrate time, not continuously.
    const appGrants = [...src.matchAll(/GRANT[\s\S]{0,400}?TO\s+leadwolf_app/gi)].map(
      (m) => m[0] as string,
    );
    for (const g of appGrants) {
      expect(/\bmaster_[a-z_]+/.test(g)).toBe(false);
    }
  });
});
