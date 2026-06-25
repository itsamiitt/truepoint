// masterGraphIsolation.itest.ts — the MANDATORY Layer-0 cross-tenant + grant-off isolation proof for the
// prospect↔company master graph (prospect-company-data Phase 1+2: PLAN_01 §5.5 / PLAN_02 §RLS / PLAN_04 §RLS-3.4 /
// PLAN_07 §RLS-3, the security mandate that BLOCKS MERGE). On a real Postgres 16 (Testcontainers by default, or an
// external server via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module
// singleton): `bun test ./packages/db/test/masterGraphIsolation.itest.ts`.
//
// Layer 0 (master_companies, master_persons, master_employment, master_emails, master_phones, source_records,
// match_links) is SYSTEM-OWNED — no workspace_id, no RLS policy, and crucially NO grant to the non-BYPASSRLS
// leadwolf_app role. Isolation here is NOT an RLS row filter; it is the GRANT-OFF WALL: a tenant tx (leadwolf_app)
// cannot even address the master tables (privilege-denied, Postgres SQLSTATE 42501). This file proves, against the
// frozen Phase-1+2 DDL:
//   (1) THE GRANT-OFF WALL — under leadwolf_app, a SELECT on EACH master table THROWS with code 42501 (denied),
//       not zero rows (PLAN_02 §RLS, PLAN_04 §RLS-3.4, PLAN_07 §RLS-3, F1);
//   (2) the overlay FK and the wall COEXIST — leadwolf_app can INSERT a contacts row whose master_person_id points
//       at a master_persons row it CANNOT itself SELECT (the FK referential check runs with the table-owner
//       privilege), proving the bridge works without granting a Layer-0 read (PLAN_01 §1, PLAN_02 §2);
//   (3) the new master_person_id column did NOT weaken overlay FORCE-RLS — a wrong-workspace read and an unscoped
//       read of that contact both return ZERO rows, fail-closed (PLAN_07 S2; rls/contacts.sql);
//   (4) the edge integrity constraints hold — uniq_employment_stint (one stint per person/company/started_on) and
//       the uniq_employment_primary partial unique (at most one primary edge per person) both reject violations
//       (PLAN_02 §0.1, F2/F3).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

// Every Layer-0 system table: leadwolf_app holds NO grant on any of them (the wall, PLAN_07 S0).
const MASTER_TABLES = [
  "master_persons",
  "master_companies",
  "master_employment",
  "master_emails",
  "master_phones",
  "source_records",
  "match_links",
] as const;

// Postgres "insufficient_privilege" — the proof the wall is grant-off (a denied SELECT), not an RLS row filter.
const PERMISSION_DENIED = "42501";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";

// Seeded Layer-0 ids (via the privileged admin/owner connection — the master tables have no app grant).
let masterPersonId = "";
let masterCompanyId = "";

// Cross-test carry: the overlay contact id created in test 2 and asserted isolated in test 3.
let contactForRls = "";

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
}

async function seedTenant(slug: string): Promise<Seeded> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  const wsId = (w as { id: string }).id;
  return { tenantId, wsId, ownerId };
}

beforeAll(async () => {
  dbHandle = await startItestDb("masterGraphIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  // admin = the privileged owner/bypass connection used for ALL Layer-0 seeding (leadwolf_app has no master grant);
  // app = the non-BYPASSRLS leadwolf_app role the isolation proofs connect with.
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB } = await seedTenant("globex"));

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");

  // ── Layer-0 fixture graph, seeded via the privileged admin connection ─────────────────────────────────────
  // master_companies (name required).
  const [mc] = await admin`
    INSERT INTO master_companies (name) VALUES ('Northwind Traders') RETURNING id`;
  masterCompanyId = (mc as { id: string }).id;

  // master_persons (the golden person — current-state projection).
  const [mp] = await admin`
    INSERT INTO master_persons (full_name) VALUES ('Jane Prospect') RETURNING id`;
  masterPersonId = (mp as { id: string }).id;

  // master_employment — the person↔company edge (master_person_id + master_company_id required). Mark it the
  // current primary stint so the partial-unique edge constraint is exercised in test 4.
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, title, is_current, is_primary, started_on)
    VALUES (${masterPersonId}, ${masterCompanyId}, 'VP Sales', true, true, DATE '2020-01-01')`;

  // master_emails — encrypted channel record: email_enc bytea + a UNIQUE email_blind_index bytea (distinct value).
  await admin`
    INSERT INTO master_emails (master_person_id, email_enc, email_blind_index)
    VALUES (${masterPersonId}, '\\xDEADBEEF'::bytea, '\\xCAFEBABE'::bytea)`;

  // source_records — the immutable evidence log (source_name + content_hash + raw_data). Distinct content_hash.
  await admin`
    INSERT INTO source_records (source_name, content_hash, raw_data)
    VALUES ('apollo', '\\xFEEDFACE'::bytea, '{"seed":true}'::jsonb)`;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

// Run a single statement as leadwolf_app inside a fully-GUC'd tenant tx; return the SQLSTATE it threw (or "").
// Used to prove the grant-off wall denies EVERY DML verb (SELECT/INSERT/UPDATE/DELETE), not just reads — a WRITE
// into the shared golden graph poisons every tenant, so the more dangerous half must be locked in too.
async function deniedCode(stmt: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      await tx.unsafe(stmt);
    });
  } catch (e) {
    return (e as { code?: string }).code ?? "";
  }
  return "";
}

describe("Layer-0 master graph isolation (Phase 1+2, grant-off wall) — BLOCKS MERGE", () => {
  // ── TEST 1: THE GRANT-OFF WALL (the central proof) ────────────────────────────────────────────────────────
  // For EACH master table, leadwolf_app must be DENIED (42501) on EVERY DML verb — not return zero rows. Isolation
  // here is grant-off, not an RLS predicate (PLAN_02 §RLS / PLAN_04 §RLS-3.4 / PLAN_07 §RLS-3). Each statement runs
  // inside a fully-GUC'd tenant tx so the denial is proven to be the missing GRANT, not a missing GUC / RLS filter.
  test("THE GRANT-OFF WALL: leadwolf_app is denied (42501) ALL DML on every master_* table — read AND write", async () => {
    for (const table of MASTER_TABLES) {
      // SELECT, INSERT, UPDATE, DELETE must ALL be permission-denied: REVOKE ALL strips every verb. A write into
      // the shared golden graph (poisoning every tenant / injecting attacker rows) is the more dangerous half —
      // assert it too so a future narrowing of the REVOKE to read-only is caught (per-table, per-verb).
      expect(await deniedCode(`SELECT * FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`INSERT INTO ${table} DEFAULT VALUES`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`UPDATE ${table} SET id = id`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
    }
  });

  // ── TEST 2: the overlay FK + the grant-off wall COEXIST ───────────────────────────────────────────────────
  // leadwolf_app cannot SELECT master_persons (test 1), yet it CAN insert a contacts row whose master_person_id
  // references that very row — the FK referential check runs with the table-owner privilege, not leadwolf_app's.
  test("overlay FK + wall coexist: leadwolf_app links a contact to a master_persons row it cannot SELECT", async () => {
    const contactId = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const [row] = await tx`
        INSERT INTO contacts (tenant_id, workspace_id, master_person_id)
        VALUES (${tenantA}, ${wsA}, ${masterPersonId})
        RETURNING id`;
      return (row as { id: string }).id;
    });
    expect(contactId).toBeTruthy();

    // Verify via the privileged admin connection that the link materialized (the app role cannot read master_*,
    // so the proof of the cross-layer reference is taken at the owner level).
    const [r] = await admin`
      SELECT master_person_id AS mp FROM contacts WHERE id = ${contactId}`;
    expect((r as { mp: string }).mp).toBe(masterPersonId);

    // Stash for test 3's isolation checks.
    contactForRls = contactId;
  });

  // ── TEST 3: overlay FORCE-RLS intact with the new master_person_id column ─────────────────────────────────
  // The contact inserted for wsA (test 2) must be invisible to wsB and to an unscoped read — fail-closed. The new
  // FK column did not weaken workspace isolation (PLAN_07 S2; rls/contacts.sql FORCE RLS + NULLIF fail-closed).
  test("overlay FORCE-RLS intact: the linked contact is zero-rows for the wrong workspace AND unscoped", async () => {
    expect(contactForRls).toBeTruthy();

    // Wrong workspace (wsB) — RLS USING filters it out.
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const [c] = await tx`SELECT count(*)::int AS n FROM contacts WHERE id = ${contactForRls}`;
      return (c as { n: number }).n;
    });
    expect(wrong).toBe(0);

    // Unscoped (no GUC set) — NULLIF(current_setting(...,true),'') is NULL → fail-closed, zero rows.
    const unscoped = await app.begin(async (tx) => {
      const [c] = await tx`SELECT count(*)::int AS n FROM contacts WHERE id = ${contactForRls}`;
      return (c as { n: number }).n;
    });
    expect(unscoped).toBe(0);

    // Sanity: the OWNING workspace (wsA) still sees exactly its row — isolation, not blanket denial.
    const right = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const [c] = await tx`SELECT count(*)::int AS n FROM contacts WHERE id = ${contactForRls}`;
      return (c as { n: number }).n;
    });
    expect(right).toBe(1);
  });

  // ── TEST 4: edge integrity constraints ───────────────────────────────────────────────────────────────────
  // Both edge uniques are DB-enforced (PLAN_02 §0.1). Exercised via the privileged admin connection (the only
  // role that can write master_employment). The seed row in beforeAll is the existing primary stint.
  test("edge integrity: uniq_employment_stint and uniq_employment_primary both reject violations", async () => {
    // (a) A SECOND stint with the same (master_person_id, master_company_id, started_on) violates
    // uniq_employment_stint — boomerangs need DISTINCT known starts; an identical key must collide.
    let stintThrew = false;
    try {
      await admin`
        INSERT INTO master_employment
          (master_person_id, master_company_id, is_current, is_primary, started_on)
        VALUES (${masterPersonId}, ${masterCompanyId}, false, false, DATE '2020-01-01')`;
    } catch {
      stintThrew = true;
    }
    expect(stintThrew).toBe(true);

    // (b) A SECOND is_primary=true edge for the same master_person_id violates the uniq_employment_primary partial
    // unique (at most one primary per person) — the seed row already holds the slot. Use a different company +
    // started_on so ONLY the primary constraint can be the cause of the failure, not uniq_employment_stint.
    const [mc2] = await admin`
      INSERT INTO master_companies (name) VALUES ('Contoso Ltd') RETURNING id`;
    const otherCompanyId = (mc2 as { id: string }).id;

    let primaryThrew = false;
    try {
      await admin`
        INSERT INTO master_employment
          (master_person_id, master_company_id, is_current, is_primary, started_on)
        VALUES (${masterPersonId}, ${otherCompanyId}, true, true, DATE '2023-06-01')`;
    } catch {
      primaryThrew = true;
    }
    expect(primaryThrew).toBe(true);
  });
});
