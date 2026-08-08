// jobChangeSweep.itest.ts — the S-13 fan-out SWEEP (intelligence-platform 07 §4 slice 7.1). The producer
// itself is covered by jobChangeAlerts.itest.ts; this covers the layer above it, which that file cannot see:
// the owner-connection census, the watermark that bounds it, the per-workspace Layer-0 fact read, and the
// runner that puts the two claims side by side.
//
// FOUR PROPERTIES THAT NEED A REAL DATABASE, all of whose failure modes are silent:
//   1. The watermark bounds the census. If the predicate is wrong the first enabled tick replays every
//      historical employment change as a live alert — the single failure that permanently burns S-13's
//      notification channel, and the reason the sweep starts at NOW when the watermark is absent.
//   2. The Layer-0 fact read is workspace-scoped. It runs on the OWNER connection, where RLS is NOT the wall
//      — the explicit workspace predicate IS the wall. If it is ever dropped, one tenant's people enter
//      another tenant's read set and nothing raises.
//   3. Only primary+current edges trigger. A historical stint must not read as a move.
//   4. The runner composes end to end against REAL columns. The unit tests exercise detectJobChange with
//      hand-built claims; only a database proves the column mapping (match_method → method, source_count →
//      distinctSources, observed_at → ageDays) and the `= ANY($1::uuid[])` parameter binding actually work.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");
// Core via the RELATIVE barrel, not @leadwolf/core: packages/db must not depend on core (Turbo cycle) —
// the idiom contactMerge.itest.ts and jobChangeAlerts.itest.ts both use and document.
type CoreModule = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let core: CoreModule;

// Tenant A — the tenant under test.
let tenantA = "";
let wsA = "";
let userA = "";
let contactA = "";
// Tenant B — holds a contact for the SAME master person. Exists solely to prove it never leaks into A.
let tenantB = "";
let wsB = "";
let contactB = "";

// Layer 0.
let personId = "";
let oldCompanyId = "";
let newCompanyId = "";

/** The watermark used by the "moved after" tests — everything seeded is dated relative to this. */
const WATERMARK = new Date("2026-06-01T00:00:00Z");
const BEFORE_WATERMARK = new Date("2026-05-01T00:00:00Z");
const AFTER_WATERMARK = new Date("2026-07-01T00:00:00Z");

async function makeTenant(
  slug: string,
): Promise<{ tenantId: string; wsId: string; userId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const userId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${userId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${userId}) RETURNING id`;
  return { tenantId, wsId: (w as { id: string }).id, userId };
}

/** Set the primary/current edge's employer + the transaction time the census watermarks on. */
async function setPrimaryEdge(companyId: string, updatedAt: Date, title = "Head of Procurement") {
  await admin`
    UPDATE master_employment
       SET master_company_id = ${companyId}, title = ${title}, updated_at = ${updatedAt}
     WHERE master_person_id = ${personId} AND is_primary = true`;
}

beforeAll(async () => {
  dbHandle = await startItestDb("jobChangeSweep");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const a = await makeTenant("acme");
  tenantA = a.tenantId;
  wsA = a.wsId;
  userA = a.userId;
  const b = await makeTenant("globex");
  tenantB = b.tenantId;
  wsB = b.wsId;

  // ── Layer 0: one person, two employers ──
  const [oc] = await admin`
    INSERT INTO master_companies (name) VALUES ('Initech') RETURNING id`;
  oldCompanyId = (oc as { id: string }).id;
  const [nc] = await admin`
    INSERT INTO master_companies (name) VALUES ('Globex Corporation') RETURNING id`;
  newCompanyId = (nc as { id: string }).id;

  const [p] = await admin`
    INSERT INTO master_persons (full_name, first_name, last_name)
    VALUES ('Dana Reyes', 'Dana', 'Reyes') RETURNING id`;
  personId = (p as { id: string }).id;

  // The PRIMARY current edge — the one the sweep reads. observed_at/source_count/match_method are what make
  // the new claim strong enough to beat the tenant's prior.
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, title, is_current, is_primary,
       match_method, source_count, observed_at, updated_at)
    VALUES (${personId}, ${oldCompanyId}, 'Head of Procurement', true, true,
            'deterministic', 3, now(), ${BEFORE_WATERMARK})`;
  // A NON-primary historical stint. Property 3: this must never trigger a fan-out on its own.
  //
  // started_on is EXPLICIT, and that is load-bearing. uniq_employment_stint is
  // (master_person_id, master_company_id, started_on), and started_on defaults to '-infinity'. The first
  // version of this fixture left both rows on the default, so the moment a test moved the primary edge to
  // newCompanyId it collided with this row — CI: duplicate key value violates unique constraint
  // "uniq_employment_stint". A historical stint should carry a real start date anyway.
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, title, is_current, is_primary,
       started_on, ended_on, match_method, source_count, observed_at, updated_at)
    VALUES (${personId}, ${newCompanyId}, 'Buyer', false, false,
            DATE '2019-01-01', DATE '2021-06-30',
            'deterministic', 3, now(), ${AFTER_WATERMARK})`;

  // ── Layer 1: both tenants hold this person, believing the OLD employer ──
  // The believed employer hangs off the contact's ACCOUNT — `contacts` carries master_person_id, `accounts`
  // carries master_company_id. Seeding it on the contact is what the first version of this file did, and CI
  // rejected it outright: column "master_company_id" of relation "contacts" does not exist.
  const mkContact = async (tenantId: string, wsId: string) => {
    const [acct] = await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name, master_company_id)
      VALUES (${tenantId}, ${wsId}, 'Initech', ${oldCompanyId}) RETURNING id`;
    const [c] = await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name, job_title,
                            master_person_id, account_id, last_verified_at)
      VALUES (${tenantId}, ${wsId}, 'Dana', 'Reyes', 'Head of Procurement',
              ${personId}, ${(acct as { id: string }).id}, ${BEFORE_WATERMARK})
      RETURNING id`;
    return (c as { id: string }).id;
  };
  contactA = await mkContact(tenantA, wsA);
  contactB = await mkContact(tenantB, wsB);

  // Tenant A saves the contact, so a real move must reach a watcher.
  const [l] = await admin`
    INSERT INTO lists (tenant_id, workspace_id, owner_user_id, name)
    VALUES (${tenantA}, ${wsA}, ${userA}, 'Targets') RETURNING id`;
  await admin`
    INSERT INTO list_members (tenant_id, workspace_id, list_id, contact_id, added_by_user_id)
    VALUES (${tenantA}, ${wsA}, ${(l as { id: string }).id}, ${contactA}, ${userA})`;

  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("job-change sweep — census and watermark", () => {
  test("a change BEFORE the watermark does not surface", async () => {
    // The seeded primary edge is dated BEFORE_WATERMARK. This is the alert-storm defence in its load-bearing
    // form: if this predicate is wrong, enabling the sweep replays history at every watcher at once.
    const rows =
      await dbmod.jobChangeSweepRepository.listWorkspacesWithEmploymentChanges(WATERMARK);
    expect(rows.some((r) => r.workspaceId === wsA)).toBe(false);
  });

  test("a change AFTER the watermark surfaces the holding workspaces", async () => {
    await setPrimaryEdge(newCompanyId, AFTER_WATERMARK);
    const rows =
      await dbmod.jobChangeSweepRepository.listWorkspacesWithEmploymentChanges(WATERMARK);
    const found = rows.filter((r) => r.workspaceId === wsA || r.workspaceId === wsB);
    // BOTH tenants hold this person, and the census is deliberately cross-tenant — that is exactly the
    // question no tenant role may ask, and why it runs on the owner connection.
    expect(found.length).toBe(2);
    expect(found.map((r) => r.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });
});

describe("job-change sweep — the Layer-0 fact read is workspace-scoped", () => {
  test("tenant A's read contains the person, with the columns the decision needs", async () => {
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      WATERMARK,
    );
    const row = observed.get(personId);
    expect(row).toBeDefined();
    expect(row?.masterCompanyId).toBe(newCompanyId);
    // The employer NAME is what makes the alert say where they went.
    expect(row?.companyName).toBe("Globex Corporation");
    // The three columns that price the new claim's confidence.
    expect(row?.matchMethod).toBe("deterministic");
    expect(row?.sourceCount).toBe(3);
    expect(row?.ageDays).not.toBeNull();
  });

  test("a workspace that does NOT hold the person gets an empty read", async () => {
    // The owner connection has no RLS, so the explicit workspace predicate IS the isolation wall here. A
    // regression that drops it leaks silently — nothing errors, the map is just wrong.
    const { wsId: strangerWs, tenantId: strangerTenant } = await makeTenant("stranger");
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: strangerTenant, workspaceId: strangerWs },
      WATERMARK,
    );
    expect(observed.size).toBe(0);
  });

  test("only the PRIMARY current edge is read — a historical stint is not a move", async () => {
    // Both edges exist for this person and both are dated after the watermark by now; the read must still
    // return exactly one row, the primary one.
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      WATERMARK,
    );
    expect(observed.size).toBe(1);
    expect(observed.get(personId)?.title).toBe("Head of Procurement");
  });
});

describe("job-change sweep — the runner, end to end", () => {
  test("a real Layer-0 move produces a signal and notifies the watcher", async () => {
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      WATERMARK,
    );
    const res = await core.runJobChangeSweepForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      observed,
      { batchSize: 100, maxBatches: 5 },
    );
    expect(res.scanned).toBe(1);
    expect(res.detected).toBe(1);
    expect(res.notified).toBe(1);
    expect(res.drained).toBe(true);

    const [s] = await admin`
      SELECT signal_type, detail FROM intent_signals WHERE contact_id = ${contactA}`;
    expect((s as { signal_type: string }).signal_type).toBe("job_change");
    // The tenant believed Initech; Layer 0 now says Globex, with a known destination.
    expect((s as { detail: string }).detail).toBe("moved");

    const [n] = await admin`
      SELECT title FROM notifications WHERE type = 'job_change' AND entity_id = ${contactA}`;
    expect((n as { title: string }).title).toContain("Globex Corporation");
  });

  test("the sweep never crosses into tenant B's contact", async () => {
    // Same person, same Layer-0 move — but the run above was scoped to workspace A, and RLS bounds the
    // tenant-side write. Tenant B learns nothing until its OWN pass runs.
    const [n] = await admin`
      SELECT count(*)::int AS n FROM intent_signals WHERE contact_id = ${contactB}`;
    expect((n as { n: number }).n).toBe(0);
  });

  test("re-running the same pass writes no second notification", async () => {
    // The watermark normally prevents a repeat, but a partial tick deliberately holds it back and re-censuses
    // — so the producer's per-(user, contact) dedup has to absorb the overlap.
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      WATERMARK,
    );
    const res = await core.runJobChangeSweepForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      observed,
      { batchSize: 100, maxBatches: 5 },
    );
    expect(res.notified).toBe(0);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM notifications
       WHERE type = 'job_change' AND entity_id = ${contactA}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("when Layer 0 agrees with what the tenant believes, nothing is written", async () => {
    // The contact still points at Initech. Re-point the primary edge back and confirm the decision function
    // reports same_employment rather than manufacturing a move out of an unchanged fact.
    await setPrimaryEdge(oldCompanyId, AFTER_WATERMARK);
    const observed = await dbmod.jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      WATERMARK,
    );
    const before =
      await admin`SELECT count(*)::int AS n FROM intent_signals WHERE contact_id = ${contactA}`;
    const res = await core.runJobChangeSweepForWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      observed,
      { batchSize: 100, maxBatches: 5 },
    );
    expect(res.detected).toBe(0);
    const after =
      await admin`SELECT count(*)::int AS n FROM intent_signals WHERE contact_id = ${contactA}`;
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n);
  });
});
