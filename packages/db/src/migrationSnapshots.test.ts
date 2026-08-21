// migrationSnapshots.test.ts — a RATCHET on the drizzle snapshot chain (part of P-1.7).
//
// The chain is broken: there are 29 snapshots in meta/ against 83 journal entries. drizzle-kit derives the
// next migration by diffing the schema against the newest snapshot, so a chain with 54 missing links makes
// `generate` produce wrong output — and, worse, produce it silently. That is the real cost: not that the
// files are missing, but that the tool cannot tell you they are.
//
// Repairing it (stitching the snapshots until `generate` reports no further diff) is the actual P-1.7 work
// and is not done here. What IS done is stopping the gap from growing. Every hand-authored migration added
// without a snapshot widens the deficit and makes the eventual repair harder, and nothing currently notices.
//
// So this pins the deficit at its known value. Adding a migration without a snapshot fails this test, which
// is the signal to either add the snapshot or make the widening a conscious decision. When the chain is
// repaired, set EXPECTED_DEFICIT to 0 and this becomes the equality assertion P-1.7 asks CI for.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const META_DIR = join(import.meta.dir, "migrations", "meta");

/** The historical gap (P-1.7): NOT a target — a ceiling that must never rise without a stated reason. The
 *  chain has been REBASELINED (migration 0083 carries a snapshot derived from the current schema, so
 *  `generate` diffs correctly and reports no changes), but the missing HISTORICAL snapshots are not restored
 *  and point-in-time diffing before 0083 remains impossible. That is acceptable — the chain is only consumed
 *  forward — and this constant keeps the gap from widening unnoticed.
 *
 *  54 → 57 on 2026-07-31, a deliberate widening for the Phase 1 spine (0088/0089/0090). drizzle-kit could not
 *  have produced these snapshots even if it were run:
 *    • 0088 is a pure feature_flags seed — INSERTs only, no DDL, so there is nothing for a snapshot to hold.
 *    • 0089 creates provenance_event, which is PARTITIONED BY RANGE. Drizzle cannot express partitioning, so
 *      the table object is deliberately kept OUT of schema/index.ts (the schema/forge.ts precedent) and
 *      drizzle-kit therefore never sees it. A snapshot claiming otherwise would be actively misleading.
 *    • 0090 creates forge.contributor + forge.contributor_consent, in the forge schema, where hand-authoring
 *      is the standing policy and `generate` is forbidden — same as every 0073-0079 forge migration.
 *  In other words that widening is the existing policy applied to three more files, not new debt of a new
 *  kind. Tighten the constant if and when the P-1.7 chain repair lands.
 *
 *  57 → 58 for 0091_policy_lawful_basis, and this one is NOT the same case — flagging it rather than filing it
 *  alongside the others. 0091 ALTERs import_policy and enrichment_policy, both of which ARE in the drizzle
 *  barrel, so `drizzle-kit generate` could and should have produced a snapshot for it. It did not because the
 *  authoring environment had no bun to run drizzle-kit in. This is genuinely owed work: run
 *  `bun run --filter @leadwolf/db generate` and, if it emits a snapshot for 0091, commit it and drop this
 *  constant back to 57. Left as-is it is one more link missing from a chain that is already the thing P-1.7
 *  exists to repair.
 *
 *  58 → 60 for 0092_usage_event and 0093_entitlement — back in the FIRST category, not 0091's. usage_event is
 *  PARTITIONED BY RANGE (Drizzle cannot express it) and entitlement's migration is hand-authored; both table
 *  objects are therefore kept OUT of schema/index.ts on purpose, so drizzle-kit never sees either and a
 *  snapshot would describe tables `generate` does not know exist.
 *
 *  60 → 61 for 0094_suppression_match_indexes. This one belongs with 0091, NOT with the partitioned/forge
 *  group: it adds indexes to suppression_list, which IS in the drizzle barrel, so `generate` could and should
 *  have produced a snapshot. It did not because this environment has no bun.
 *
 *  CORRECTION (2026-08-04), now that bun IS available and drizzle-kit has actually been run: the fix those two
 *  paragraphs prescribe does not work. `generate` emits a snapshot only ALONGSIDE a migration it is generating;
 *  against the current schema it reports "No schema changes, nothing to migrate" and writes nothing. It cannot
 *  retroactively produce a snapshot for an already-committed file. So 0091's and 0094's missing links are not
 *  repayable by running the command — they need a hand-authored snapshot or another rebaseline (which is what
 *  0095 did for the chain HEAD). The debt is real; the stated remedy was not.
 *
 *  61 → 62 for 0097_contribution_controls — the FIRST category. contribution_policy, contribution_exclusion
 *  and crm_object_contribution are hand-authored and deliberately kept out of schema/index.ts, exactly as
 *  entitlement and usage_event are, so drizzle-kit never sees them and a snapshot would describe tables
 *  `generate` does not know exist. Confirmed by running it: no drift reported after this migration landed.
 *
 *  62 → 66 for the intelligence-platform Layer 0 (0100-0107). Eight migrations, four WITH snapshots
 *  (0100/0104/0105/0107 are drizzle-generated), four without — and all four are the FIRST category, the same
 *  case as usage_event and provenance_event, not 0091's genuinely-owed debt:
 *    • 0101 master_technology_adoptions and 0103 master_signals are PARTITIONED BY RANGE. Drizzle cannot
 *      express partitioning, so both table objects are deliberately kept OUT of schema/index.ts (the
 *      provenance_event precedent) and drizzle-kit never sees them. A snapshot would describe tables
 *      `generate` does not know exist.
 *    • 0102 defines two FUNCTIONS (mirror_partition_acl, ensure_month_partitions) and touches no table.
 *      There is nothing for a snapshot to hold — the 0088 seed case.
 *    • 0106 creates three indexes with CREATE INDEX CONCURRENTLY, which is precisely why it is hand-authored:
 *      Drizzle emits a plain blocking CREATE INDEX for anything declared in a schema file.
 *  This test caught the widening and forced it to be stated, which is exactly what it is for.
 *
 *  66 → 67 for 0108_org_kind_and_education — the FIRST category again, not owed debt. The migration adds
 *  master_education, whose table object is deliberately kept OUT of schema/index.ts (the
 *  masterTechnologyAdoption/provenanceEvent precedent) because its two PARTIAL UNIQUE indexes and its CITEXT
 *  column are expressed in hand-authored SQL; drizzle-kit never sees the module, so a snapshot would describe
 *  a table `generate` does not know exists. The same migration also touches master_companies (adds org_kind,
 *  drops the dead technographics blob) — that part IS visible to drizzle, but a snapshot cannot be emitted
 *  for half a migration, and the chain HEAD stays at 0107 until the next rebaseline.
 *  This test caught the widening again and forced it to be stated.
 *
 *  67 → 68 for 0109_fk_access_path_indexes — the FIRST category again, and the same case as 0106. Every
 *  statement in it is CREATE INDEX CONCURRENTLY, which cannot run inside a transaction block; Drizzle emits
 *  a plain blocking CREATE INDEX for anything declared in a schema file, so these indexes are deliberately
 *  hand-authored and invisible to `generate`. It also adds one FK constraint, which drizzle-kit COULD see —
 *  but a snapshot cannot be emitted for half a migration, and the chain HEAD stays at 0107 until the next
 *  rebaseline.
 *
 *  68 → 69 for 0110_worker_outbox_fks — the FIRST category once more. It ends in two CREATE INDEX
 *  CONCURRENTLY statements (the cascade-supporting indexes), which cannot run inside a transaction block and
 *  which drizzle-kit would emit as plain blocking CREATE INDEX from a schema file. The two FK constraints in
 *  it ARE declared in schema/workerOutbox.ts and drizzle-kit could see those — but, as with 0109, a snapshot
 *  cannot be emitted for half a migration, so the chain HEAD stays at 0107.
 *
 *  69 → 70 for 0111_enrichment_waterfall_v2 (renumbered from 0109 on merge — main took 0109/0110 for the
 *  fk-index pair concurrently; the M12-email precedent) — 0091's category, stated as such. Every table it
 *  touches (provider_calls, source_imports, enrichment_policy, audit_log) IS in the drizzle barrel, but the
 *  migration is hand-authored on purpose: two CHECK-constraint widenings (source_imports_source_name_enum,
 *  audit_log_action_enum) and a unique-index REPLACEMENT (the (ws,hash)→(ws,hash,provider) ledger fix)
 *  are drop+recreate shapes drizzle-kit does not emit as written. Per the 2026-08-04 correction above, a
 *  retroactive snapshot cannot be generated for an already-committed file; the chain HEAD stays at 0107
 *  and the next rebaseline absorbs this link like 0091/0094.
 *
 *  70 → 74 for the linkedin_api source program (0112-0115), each stated per this test's protocol:
 *    • 0112 profile columns — 0091's category for the masterGraph.ts half (barrel tables; drizzle COULD
 *      see the column adds) BUT the same migration also adds precision columns to master_education, which
 *      is deliberately OUT of the barrel — the 0108 "a snapshot cannot be emitted for half a migration"
 *      case. Hand-authored per the 0105/0111 house pattern; the chain HEAD stays at 0107.
 *    • 0113 master_company_identifiers — barrel table plus a hand-appended backfill INSERT (the 0104
 *      pattern); the INSERT half is invisible to generate, so: half-a-migration again.
 *    • 0114 master_company_headcount — the FIRST category verbatim: PARTITION BY HASH, which drizzle-kit
 *      cannot express; the table object is kept OUT of schema/index.ts (masterSignals precedent).
 *    • 0115 source_imports CHECK swap — 0111's category verbatim (drop+recreate CHECK widening).
 *  The next rebaseline absorbs the 0112/0113 links exactly as it will 0091/0094/0111.
 *
 *  74 → 75 for 0116_person_attributes_and_email_type — 0091's category, stated as such. Both new tables
 *  (master_person_skills/master_person_languages) are plain and IN the barrel, and the email_type column
 *  lands on a barrel table — drizzle COULD see all of it. But the chain HEAD is 0107, so `generate`
 *  proposes every post-0107 change at once and dies on an interactive column-conflict prompt; per the
 *  2026-08-04 correction a retroactive snapshot cannot be emitted either. Hand-authored; the next
 *  rebaseline absorbs the link.
 *
 *  75 → 76 for 0117_provider_origins — the same 0116 case verbatim: a plain barrel table drizzle COULD
 *  see, but the 0107 chain HEAD makes `generate` propose all post-0107 drift and die on the interactive
 *  conflict prompt. Hand-authored; absorbed by the next rebaseline.
 *
 *  76 → 77 for 0118_source_fetch_registry — identical case to 0117: a plain barrel table hand-authored
 *  only because the 0107 chain HEAD makes `generate` unusable. Absorbed by the next rebaseline.
 *
 *  77 → 82 for the Layer-0-as-database wave (0119–0123). None of these are expressible through the schema
 *  DSL even with a healthy chain: 0119 is DATA (flag seeds + a global UPDATE), 0120/0122 are CHECK-constraint
 *  swaps on source_imports.source_name, and 0123 is CREATE INDEX CONCURRENTLY with expression/partial
 *  predicates and gin_trgm_ops — none of which drizzle-kit emits. 0121 alone (two columns + a CHECK) could
 *  have been generated, but the 0107 chain HEAD makes `generate` propose every post-0107 change at once and
 *  die on the interactive prompt, exactly as 0116–0118 record. All absorbed by the next rebaseline.
 *
 *  82 → 83 for 0124_reset_unresolved_fetch_clock — pure DATA repair (clearing a freshness clock the
 *  envelope bug burned); there is no schema change for drizzle to snapshot at all.
 *
 *  83 → 89 for the market-intelligence series 0125–0130 (docs/planning/market-intelligence/): 0125
 *  tenant_signals + 0126 watchlists + 0129 account_scores are plain tables drizzle could snapshot, but the
 *  0107 chain HEAD still makes `generate` propose everything at once (the standing condition above); 0127
 *  is PARTITION BY HASH (inexpressible), 0128 is seed-heavy taxonomy DDL, 0130 is a hand-shaped rollup
 *  cache. All absorbed by the next rebaseline.
 *
 *  89 → 90 for 0131_reverify_indexes — 0123's category verbatim: CREATE INDEX CONCURRENTLY with an
 *  expression key (coalesce(last_verified_at, created_at)) and partial predicates, which drizzle-kit does
 *  not emit (perf-audit P1.6). The schema DSL carries matching index defs for documentation/dev-parity;
 *  the migration is the authority. Absorbed by the next rebaseline.
 *
 *  90 → 91 for 0132_search_filter_indexes — the 0109/0123 category again: CONCURRENTLY partial + trgm GIN
 *  indexes for the search-filter and session access paths (perf-audit P2.1). Migration-only per the 0109
 *  rationale (Drizzle would emit blocking CREATEs); absorbed by the next rebaseline.
 *
 *  91 → 92 for 0133_title_trgm_index — the 0132 category once more: the job_title trgm GIN that batch
 *  missed (launch-scale Phase 2 finding F3; CONCURRENTLY, migration-only per the 0109 rationale).
 *  Absorbed by the next rebaseline.
 *
 *  92 → 93 for 0134_database_company_search — the same category a fourth time: the PARTIAL + expression +
 *  trgm/array GIN index set for the global company search (search-consolidation stage 2). Migration-only
 *  per the 0109 rationale — every index is CONCURRENTLY (drizzle-kit emits blocking CREATEs), several are
 *  partial on MASTER_COMPANY_VISIBLE, and one is an expression index on coalesce(employee_count, -1),
 *  none of which the schema DSL can express without drift. Absorbed by the next rebaseline.
 *
 *  93 → 94 for 0135_database_people_filters — the same category once more: the People-side global filter
 *  indexes (employer join, phone line_type, the attribute EXISTS tables, the primary-stint start date).
 *  CONCURRENTLY + partial on MASTER_PERSON_VISIBLE, migration-only per the 0109 rationale. Absorbed by the
 *  next rebaseline. */
const EXPECTED_DEFICIT = 94;

function journalEntryCount(): number {
  const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

function snapshotCount(): number {
  return readdirSync(META_DIR).filter((f) => f.endsWith("_snapshot.json")).length;
}

describe("drizzle snapshot chain", () => {
  test("the snapshot deficit does not grow (P-1.7 ratchet)", () => {
    // A hand-authored migration added without a snapshot widens the break silently. This is the only thing
    // that notices.
    const deficit = journalEntryCount() - snapshotCount();
    expect(deficit).toBeLessThanOrEqual(EXPECTED_DEFICIT);
  });

  test("EXPECTED_DEFICIT is honest — tighten it whenever the gap shrinks", () => {
    // A ratchet that is never tightened stops being a ratchet. If snapshots get stitched back in and this
    // constant is left stale, the guard silently loosens by exactly the amount that was repaired.
    const deficit = journalEntryCount() - snapshotCount();
    expect(deficit).toBe(EXPECTED_DEFICIT);
  });

  test("every journal entry has a tag and they are unique", () => {
    // Identity is journal ORDER + the file's sha256, so a duplicate tag is not fatal to the migrator — but it
    // makes the chain unreadable to a human and is how the duplicate 0053_* pair P-1.7 mentions arose.
    const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
      entries: Array<{ tag?: string }>;
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("journal idx values are strictly increasing (the order the migrator replays)", () => {
    const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number }>;
    };
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]?.idx ?? -1;
      const cur = journal.entries[i]?.idx ?? -1;
      expect(cur).toBeGreaterThan(prev);
    }
  });
});
