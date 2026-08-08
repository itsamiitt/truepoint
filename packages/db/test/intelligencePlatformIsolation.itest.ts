// intelligencePlatformIsolation.itest.ts — the access-path wall around the intelligence-platform Layer-0
// tables (migrations 0100–0107), and the one thing `04-validation.md` made the whole design's security
// verdict CONDITIONAL on.
//
// Layer 0 carries no workspace_id, so no fail-closed RLS predicate can be written over it. Isolation is the
// GRANT, and nothing else. That makes it exactly the kind of boundary that is invisible until someone tests
// it: every gate these tables passed so far — typecheck, biome, depcruise — is blind to a missing REVOKE.
//
// Four properties, each of which caught or would catch a real defect:
//
//   (1) THE CUSTOMER ROLE CANNOT REACH THEM. leadwolf_app is denied every DML verb on all thirteen tables.
//   (2) PARTITIONS ARE DENIED BY NAME. Partition ACLs do NOT inherit in Postgres — privileges are checked on
//       the relation NAMED in the query — so `REVOKE ALL ON master_signals` says nothing about
//       `master_signals_2026_08`, which the monthly sweep creates under a completely predictable name and
//       which picks up the schema-wide default GRANT. That gap was live for `provenance_event` before
//       migration 0102; this asserts it is closed for the new tables AND stays closed.
//   (3) THE RESOLVER ROLE CAN ACTUALLY WORK. leadwolf_er holds SELECT/INSERT/UPDATE on the eleven writable
//       tables. Without this the repositories shipped in Phase 6.2 fail at runtime with 42501 — which is
//       precisely the bug found in iteration 16, and the reason this test exists rather than being assumed.
//   (4) THE RESOLVER CANNOT DELETE. Erasure is an audited privileged operation; leadwolf_er holding DELETE
//       would put a DSAR-shaped capability on an ingest path.
//
// ON THE ASSERTION SHAPE — this is the subtle one. The house rule is that an RLS denial must be asserted as
// "affected zero rows", never as "threw", because UPDATE/DELETE under a MISSING POLICY silently affect
// nothing. That rule does NOT apply here: these tables have no RLS at all, and the wall is grant-absence, so
// every verb raises 42501 including SELECT. Asserting the error code is correct precisely BECAUSE the
// mechanism is a grant rather than a policy — and if someone ever adds RLS to these tables, this test's
// shape must be revisited along with it.
//
//   bun test ./packages/db/test/intelligencePlatformIsolation.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("../src/index.ts");

const PERMISSION_DENIED = "42501";

/** Every table migrations 0100–0107 added. All Layer-0, all system-owned, none RLS-scoped. */
const LAYER0_TABLES = [
  "master_technologies",
  "master_technology_categories",
  "master_technology_aliases",
  "master_technology_vendors",
  "master_technology_features",
  "master_technology_adoptions",
  "master_signals",
  "master_signal_types",
  "master_company_locations",
  "master_company_contact_points",
  "master_company_funding",
  "master_person_identifiers",
  "master_confidence_policy",
] as const;

/** The eleven the resolver writes. The two omitted — master_signal_types, master_confidence_policy — are
 *  staff-authored config it may read but must never rewrite. */
const ER_WRITABLE = LAYER0_TABLES.filter(
  (t) => t !== "master_signal_types" && t !== "master_confidence_policy",
);

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("intelPlatformIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("../src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

function pgCode(e: unknown): string {
  return (e as { code?: string })?.code ?? String(e);
}

/** Run a statement as leadwolf_app; return the SQLSTATE it failed with, or "" if it succeeded. */
async function appDeniedCode(stmt: string): Promise<string> {
  try {
    await app.unsafe(stmt);
  } catch (e) {
    return pgCode(e);
  }
  return "";
}

/** Run a statement as leadwolf_er; return the SQLSTATE it failed with, or "" if it succeeded.
 *  NOT `expect(...).rejects` — a promise holding a pooled connection can be left unsettled, which hangs the
 *  assertion AND every later query in the file (the itest pools are max:1). Explicit try/catch, per the house
 *  rule that partitionMaintenance, contactMerge and tags all learned the hard way. */
async function erDeniedCode(stmt: string): Promise<string> {
  try {
    await dbmod.withErTx(async (tx) => {
      await tx.execute(sql.raw(stmt));
    });
  } catch (e) {
    return pgCode(e);
  }
  return "";
}

describe("intelligence-platform Layer 0 — the access-path wall", () => {
  // ── (1) THE CUSTOMER ROLE CANNOT REACH THEM ───────────────────────────────────────────────────────────
  test("leadwolf_app is denied (42501) every DML verb on all Layer-0 tables", async () => {
    for (const table of LAYER0_TABLES) {
      expect(await appDeniedCode(`SELECT 1 FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`INSERT INTO ${table} DEFAULT VALUES`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`UPDATE ${table} SET id = id`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
    }
  });

  // ── (2) PARTITIONS ARE DENIED BY NAME (the 0102 fix) ──────────────────────────────────────────────────
  // Discovered from the catalog rather than guessed: ensure_month_partitions names them parent_YYYY_MM, and
  // a test that hard-coded this month's name would start passing vacuously the moment the name drifted.
  test("every partition of a Layer-0 partitioned table is denied to leadwolf_app BY NAME", async () => {
    const parts = await admin<Array<{ child: string; parent: string }>>`
      SELECT ch.relname AS child, pa.relname AS parent
        FROM pg_inherits i
        JOIN pg_class ch ON ch.oid = i.inhrelid
        JOIN pg_class pa ON pa.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = ch.relnamespace
       WHERE n.nspname = 'public'
         AND pa.relname IN ('master_signals', 'master_technology_adoptions')`;

    // If this is zero the test would pass by asserting nothing — the exact failure mode the block budget and
    // the migration comments keep warning about. The migrations create months + a DEFAULT partition, so
    // there is always at least one.
    expect(parts.length).toBeGreaterThan(0);

    for (const p of parts) {
      expect(await appDeniedCode(`SELECT 1 FROM ${p.child} LIMIT 1`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`DELETE FROM ${p.child}`)).toBe(PERMISSION_DENIED);
    }
  });

  test("mirror_partition_acl exists and is owner-only", async () => {
    const rows = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'mirror_partition_acl'`;
    expect(one(rows).n).toBe(1);
    expect(await appDeniedCode(`SELECT mirror_partition_acl('public','x',0::regclass)`)).toBe(
      PERMISSION_DENIED,
    );
  });

  // ── (3) THE RESOLVER ROLE CAN ACTUALLY WORK ───────────────────────────────────────────────────────────
  // This is the assertion that would have caught iteration 16's bug: the repositories run under withErTx,
  // and until the grant was extended, every one of them would have failed on its first query.
  test("leadwolf_er can SELECT every Layer-0 table", async () => {
    for (const table of LAYER0_TABLES) {
      expect(await erDeniedCode(`SELECT 1 FROM ${table} LIMIT 1`)).toBe("");
    }
  });

  test("leadwolf_er can INSERT and UPDATE the catalog it resolves against", async () => {
    expect(
      await erDeniedCode(
        `INSERT INTO master_technologies (slug, canonical_name) VALUES ('itest-tech','Itest Tech')`,
      ),
    ).toBe("");
    expect(
      await erDeniedCode(
        `UPDATE master_technologies SET canonical_name = 'Itest Tech 2' WHERE slug = 'itest-tech'`,
      ),
    ).toBe("");

    const rows = await admin<Array<{ canonical_name: string }>>`
      SELECT canonical_name FROM master_technologies WHERE slug = 'itest-tech'`;
    expect(one(rows).canonical_name).toBe("Itest Tech 2");
  });

  test("leadwolf_er can write the PARTITIONED tables through their parent", async () => {
    const co = await admin<Array<{ id: string }>>`
      INSERT INTO master_companies (name, primary_domain) VALUES ('Itest Co','itest-iso.example')
      RETURNING id`;
    const tech = await admin<Array<{ id: string }>>`
      SELECT id FROM master_technologies WHERE slug = 'itest-tech'`;

    // A partitioned write is routed through the parent, so the parent grant is what matters — and the
    // partition ACL mirrored by 0102 must not have revoked the resolver along with the customer role.
    expect(
      await erDeniedCode(
        `INSERT INTO master_technology_adoptions
           (master_company_id, technology_id, detection_method, first_seen_at, last_seen_at, observed_at)
         VALUES ('${one(co).id}', '${one(tech).id}', 'dns', now(), now(), now())`,
      ),
    ).toBe("");

    const landed = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_technology_adoptions`;
    expect(one(landed).n).toBe(1);
  });

  // ── (4) THE RESOLVER CANNOT DELETE ────────────────────────────────────────────────────────────────────
  // Erasure is the audited owner/withPrivilegedTx path. A DELETE grant here would put a DSAR-shaped
  // capability on an ingest path — and it is why masterSignalsRepository.erasePersonSignals is documented
  // as NOT a withErTx call.
  test("leadwolf_er is denied DELETE on every Layer-0 table", async () => {
    for (const table of ER_WRITABLE) {
      expect(await erDeniedCode(`DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
    }
  });

  test("leadwolf_er cannot rewrite staff-authored config", async () => {
    expect(await erDeniedCode("UPDATE master_confidence_policy SET source_weight = 1.0")).toBe(
      PERMISSION_DENIED,
    );
    expect(await erDeniedCode("UPDATE master_signal_types SET default_weight = 10")).toBe(
      PERMISSION_DENIED,
    );
  });

  // ── The seeded reference data actually landed (0103 + 0107 hand-appended seeds) ────────────────────────
  test("the signal vocabulary and confidence policy seeds applied", async () => {
    const types = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_signal_types`;
    expect(one(types).n).toBeGreaterThan(0);

    // The X-04 boundary, asserted rather than trusted to a comment: no 'intent' family may exist.
    const intent = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_signal_types WHERE family = 'intent'`;
    expect(one(intent).n).toBe(0);

    const policy = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_confidence_policy WHERE field = '*' AND source_type = '*'`;
    // The universal fallback must exist, or scoreConfidence returns null for everything.
    expect(one(policy).n).toBe(1);
  });
});
