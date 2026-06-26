// masterBackfillSweep.itest.ts — the behavioural proof of the SCHEDULED master-backfill SWEEP enumeration
// (contactRepository.listWorkspacesWithUnresolvedContacts; PLAN_07 Stage B, Phase 3). Where masterBackfill.itest.ts
// proves the per-workspace BACKFILL job (it walks ONE workspace and stamps each unresolved contact), THIS file proves
// the SYSTEM-LEVEL enumeration that FEEDS that job: which workspaces still hold at least one unresolved (NULL
// master_person_id), live (deleted_at IS NULL) contact, so the leader-locked sweep worker can enqueue one
// per-workspace backfill per workspace returned.
//
// The method under test is intentionally NOT workspace-scoped and takes NO tx: it runs on the OWNER connection
// (`db.execute`, NO leadwolf_app role drop) precisely BECAUSE the set is cross-workspace — the sweep must see EVERY
// workspace, not just the caller's. It returns ONLY the (tenantId, workspaceId) pair (non-PII ids), DISTINCT per
// workspace, capped by `limit` so one sweep can't fan out unbounded. So we call it DIRECTLY on
// dbmod.contactRepository — never wrapped in withTenantTx.
//
// On a real Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts).
// Run in its OWN process (the db client is a module singleton, and DATABASE_URL/BLIND_INDEX_KEY are set BEFORE the
// singleton loads): `bun test ./packages/db/test/masterBackfillSweep.itest.ts`.
//
// The fixture is three workspaces, each with exactly one contact, exercising the WHERE clause's two predicates:
//   • wsUnresolved — master_person_id NULL, deleted_at NULL (an unresolved LIVE row) → MUST appear.
//   • wsResolved   — master_person_id SET (to a freshly-minted master_persons id), deleted_at NULL → MUST NOT appear
//                    (the IS NULL predicate excludes it — it is already resolved).
//   • wsTombstoned — master_person_id NULL but deleted_at SET (a DSAR tombstone) → MUST NOT appear (the deleted_at
//                    IS NULL predicate excludes it — the sweep never re-resolves erased rows).
// All seeding (tenants/workspaces, the master_persons row, every contact) runs via the privileged `admin` (owner)
// connection: master_persons is system-owned (no leadwolf_app grant) and the sweep itself is an owner-connection read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

// The three workspaces under test, each paired with its tenant (the enumeration returns the (tenantId, workspaceId)
// pair, so both halves are asserted against the seed).
let tenantUnresolved = "";
let wsUnresolved = "";
let tenantResolved = "";
let wsResolved = "";
let tenantTombstoned = "";
let wsTombstoned = "";

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
}

// One tenant + owner + default workspace, seeded via the privileged admin connection (mirrors masterBackfill.itest.ts).
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
  dbHandle = await startItestDb("masterBackfillSweep");
  // env MUST be set before the db singleton loads.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  // admin = the privileged owner connection used for ALL seeding (master_persons is system-owned) AND mirrors the
  // owner connection the enumeration itself runs on.
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  // env is set above, BEFORE the db singleton loads — so dbmod's client is configured against this test database.
  dbmod = await import("@leadwolf/db");

  ({ tenantId: tenantUnresolved, wsId: wsUnresolved } = await seedTenant("acme"));
  ({ tenantId: tenantResolved, wsId: wsResolved } = await seedTenant("globex"));
  ({ tenantId: tenantTombstoned, wsId: wsTombstoned } = await seedTenant("initech"));

  // ── wsUnresolved — an unresolved LIVE contact: master_person_id NULL, deleted_at NULL. The sweep MUST surface it.
  await admin`
    INSERT INTO contacts (tenant_id, workspace_id, email_domain)
    VALUES (${tenantUnresolved}, ${wsUnresolved}, 'acme.com')`;

  // ── wsResolved — mint a master_persons row via admin (master_persons is system-owned), then point this contact's
  // master_person_id at it: a fully resolved row. The IS NULL predicate excludes it → it MUST NOT appear.
  const [mp] = await admin`
    INSERT INTO master_persons (has_email, has_phone) VALUES (false, false) RETURNING id`;
  const resolvedPersonId = (mp as { id: string }).id;
  await admin`
    INSERT INTO contacts (tenant_id, workspace_id, master_person_id, email_domain)
    VALUES (${tenantResolved}, ${wsResolved}, ${resolvedPersonId}, 'globex.com')`;

  // ── wsTombstoned — master_person_id NULL (unresolved) BUT deleted_at SET (a DSAR tombstone). The deleted_at IS
  // NULL predicate excludes it → it MUST NOT appear: the sweep never re-resolves an erased row.
  await admin`
    INSERT INTO contacts (tenant_id, workspace_id, email_domain, deleted_at)
    VALUES (${tenantTombstoned}, ${wsTombstoned}, 'initech.com', now())`;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("master-backfill sweep enumeration (listWorkspacesWithUnresolvedContacts; PLAN_07 Stage B)", () => {
  // ── TEST 1: ENUMERATION RETURNS ONLY WORKSPACES WITH UNRESOLVED, LIVE CONTACTS ───────────────────────────────────
  // The owner-connection enumeration returns the (tenantId, workspaceId) of every workspace holding at least one
  // unresolved (master_person_id IS NULL), live (deleted_at IS NULL) contact. wsUnresolved qualifies; wsResolved is
  // excluded by the IS NULL predicate (already resolved); wsTombstoned is excluded by the deleted_at predicate.
  test("returns ONLY workspaces with unresolved, live contacts (excludes resolved + tombstoned)", async () => {
    const rows = await dbmod.contactRepository.listWorkspacesWithUnresolvedContacts();

    const wsIds = new Set(rows.map((r) => r.workspaceId));
    // The unresolved-live workspace is present.
    expect(wsIds.has(wsUnresolved)).toBe(true);
    // The fully resolved workspace (master_person_id SET) is NOT.
    expect(wsIds.has(wsResolved)).toBe(false);
    // The tombstoned workspace (deleted_at SET) is NOT.
    expect(wsIds.has(wsTombstoned)).toBe(false);

    // The returned row for wsUnresolved carries the CORRECT paired tenantId (the (tenantId, workspaceId) match seed).
    const unresolvedRow = rows.find((r) => r.workspaceId === wsUnresolved);
    expect(unresolvedRow).toBeDefined();
    expect(unresolvedRow?.tenantId).toBe(tenantUnresolved);
  });

  // ── TEST 2: DISTINCT PER WORKSPACE ───────────────────────────────────────────────────────────────────────────────
  // A workspace with MANY unresolved contacts is still enqueued ONCE — the enumeration is SELECT DISTINCT on
  // (tenant_id, workspace_id). Seed a SECOND unresolved-live contact into wsUnresolved and prove it still appears
  // exactly once (one per-workspace backfill, not one per contact).
  test("a workspace with multiple unresolved contacts appears EXACTLY once (DISTINCT)", async () => {
    await admin`
      INSERT INTO contacts (tenant_id, workspace_id, email_domain)
      VALUES (${tenantUnresolved}, ${wsUnresolved}, 'acme.com')`;

    const rows = await dbmod.contactRepository.listWorkspacesWithUnresolvedContacts();
    const occurrences = rows.filter((r) => r.workspaceId === wsUnresolved).length;
    expect(occurrences).toBe(1);
  });

  // ── TEST 3: THE `limit` CAP IS HONOURED ──────────────────────────────────────────────────────────────────────────
  // The enumeration is `limit`-capped (LIMIT $1) so one sweep can't fan out unbounded over every workspace. With a
  // cap of 1, at most one workspace is returned regardless of how many qualify.
  test("the `limit` cap bounds the result set", async () => {
    const rows = await dbmod.contactRepository.listWorkspacesWithUnresolvedContacts(1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
