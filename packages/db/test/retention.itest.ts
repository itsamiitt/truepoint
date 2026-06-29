// retention.itest.ts — the data-retention ENGINE gate (data-management backlog #6; design
// 16-retention-engine-design.md, spec 08-compliance §7 + ADR-0025) on a real Postgres 16 (Testcontainers by
// default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module
// singleton): `bun test ./packages/db/test/retention.itest.ts`.
//
// This is the SAFETY GATE that MUST pass before any retention class is ever flipped to `enforce` in production.
// It proves two things end-to-end against the SHIPPED engine entry points (no logic is re-implemented here):
//
//   A. RLS / access posture (rls/retention.sql):
//      A1. retention_class_policies — GLOBAL, platform-managed. The app role (withTenantTx) can SELECT the seeded
//          defaults but can NEVER INSERT (RLS WITH CHECK rejects) / UPDATE / DELETE (no policy → 0 rows).
//      A2. retention_runs — per-tenant, APPEND-ONLY. Tenant A appends + reads its own runs; tenant B cannot see
//          them (RLS); the app role can never UPDATE or DELETE a run (no policy → 0 rows; the trail is immutable).
//
//   B. The sweep (core/retention/runRetentionSweep.ts) — the 4 gates + shadow/enforce, with controlled
//      timestamps so cutoffs are deterministic (the sweep's `now` is injected; rows are seeded relative to it):
//      B3. Flag OFF (the fail-closed default) → enabled:false, records NOTHING, deletes NOTHING.
//      B4. Flag ON, default `shadow` → one retention_runs row per eligible v1 class; candidateCount = the OLD
//          rows only (newer-than-cutoff rows are NOT counted), deletedCount = 0, and NOTHING is deleted.
//      B5. Flag ON, class flipped to `enforce` (via retentionClassPolicyRepository.upsertPolicy) → the OLD rows are
//          DELETED, the newer rows REMAIN, deletedCount = the OLD-row count, and the run row reflects it.
//      B6. Tenant isolation of enforce — OLD rows seeded for BOTH tenants; enforce-sweep tenant A ONLY; tenant
//          B's rows are UNTOUCHED (the explicit tenant predicate, never RLS, is the cross-tenant safety).
//      B7. A null-ttl / not-yet-wired class (contacts, audit_log, the deferred v2 classes) is skipped — no run.
//      B8. activities (the newly-wired v2 leaf, aged on occurred_at) — flag ON + shadow counts OLD rows only,
//          deletes nothing.
//      B9. activities — flag ON + class flipped to `enforce` → the OLD rows are DELETED, the fresh ones REMAIN.
//      B10. activities — enforce is tenant-isolated: A's old rows go, B's identical-age rows are UNTOUCHED.
//
// Coverage spans both tenant-scope shapes: two `tenant_column` classes (verification_jobs aged on created_at,
// activities aged on occurred_at) AND one `workspace_join` class (import_job_rows, aged on created_at via the
// workspaces join) exercise every scope/aging shape the sweep uses.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RETENTION_ENGINE_FLAG_KEY, type RetentionDataClass } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Core = typeof import("../../core/src/index.ts");
type Count = { n: number }; // postgres.js count(*) row shape

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";

// A fixed wall-clock the sweep treats as "now" (injected via runRetentionSweepForTenant({ now })) so every cutoff
// is deterministic: cutoff = now - ttlDays. Seed timestamps are anchored to it (ttl+10d old = expired; ttl-10d).
const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBeforeNow = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

// DEFAULT_RETENTION_POLICIES ttls: verification_jobs = 730d, import_job_rows = 365d.
const VERIF_OLD = daysBeforeNow(740); // expired — older than the 730d cutoff
const VERIF_FRESH = daysBeforeNow(720); // retained — newer than the 730d cutoff
const IMPORT_OLD = daysBeforeNow(375); // expired — older than the 365d cutoff
const IMPORT_FRESH = daysBeforeNow(355); // retained — newer than the 365d cutoff
// activities = 365d (the newly-wired v2 leaf, aged on occurred_at).
const ACTIVITY_OLD = daysBeforeNow(375); // expired — older than the 365d cutoff
const ACTIVITY_FRESH = daysBeforeNow(355); // retained — newer than the 365d cutoff

interface Scope {
  tenantId: string;
  workspaceId: string;
}

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

// ── Seeders: insert rows with an EXPLICIT created_at (the repos default created_at to now(), so the controlled
// aging the sweep keys off can only be set via the owner `admin` connection — exactly how it seeds tenants). ──
async function seedVerificationJobs(scope: Scope, createdAt: Date, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await admin`
      INSERT INTO verification_jobs
        (tenant_id, workspace_id, started_at, finished_at, scanned, reverified, errored, created_at)
      VALUES (${scope.tenantId}, ${scope.workspaceId}, ${createdAt}, ${createdAt}, 0, 0, 0, ${createdAt})`;
  }
}

async function seedImportJobRows(scope: Scope, createdAt: Date, n: number): Promise<void> {
  const [job] = await admin`
    INSERT INTO import_jobs (tenant_id, workspace_id, source_file, source_name)
    VALUES (${scope.tenantId}, ${scope.workspaceId}, 's3://itest/retention.csv', 'retention.csv')
    RETURNING id`;
  const [chunk] = await admin`
    INSERT INTO import_job_chunks (job_id, chunk_index, row_start, row_end)
    VALUES (${job!.id}, 0, 0, ${n}) RETURNING id`;
  for (let i = 0; i < n; i++) {
    // created_at on the ROW is what the import_job_rows class ages on (the job/chunk created_at is irrelevant).
    await admin`
      INSERT INTO import_job_rows (job_id, chunk_id, row_index, workspace_id, outcome, created_at)
      VALUES (${job!.id}, ${chunk!.id}, ${i}, ${scope.workspaceId}, 'created', ${createdAt})`;
  }
}

// activities ages on occurred_at and needs a contact_id (NOT NULL FK) + the NOT-NULL closed-enum activity_type
// /channel cols (metadata/occurred_at default; outcome/note/actor nullable). Seed one minimal contact per scope
// (tenant_id + workspace_id are the only NOT-NULL contact cols; everything else defaults / passes the reveal
// CHECKs), then activity rows with an EXPLICIT occurred_at on the owner `admin` connection (the aging the sweep
// keys off can only be set there — the repo path defaults occurred_at to now()).
async function seedContact(scope: Scope): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id)
    VALUES (${scope.tenantId}, ${scope.workspaceId}) RETURNING id`;
  return c!.id as string;
}

async function seedActivities(
  scope: Scope,
  contactId: string,
  occurredAt: Date,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await admin`
      INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel, occurred_at)
      VALUES (${scope.tenantId}, ${scope.workspaceId}, ${contactId}, 'note_added', 'email', ${occurredAt})`;
  }
}

async function countVerification(tenantId: string): Promise<number> {
  const rows = (await admin`
    SELECT count(*)::int AS n FROM verification_jobs WHERE tenant_id = ${tenantId}`) as Count[];
  return rows[0]!.n;
}
async function countImportRows(workspaceId: string): Promise<number> {
  const rows = (await admin`
    SELECT count(*)::int AS n FROM import_job_rows WHERE workspace_id = ${workspaceId}`) as Count[];
  return rows[0]!.n;
}
async function countActivities(tenantId: string): Promise<number> {
  const rows = (await admin`
    SELECT count(*)::int AS n FROM activities WHERE tenant_id = ${tenantId}`) as Count[];
  return rows[0]!.n;
}
async function countRuns(): Promise<number> {
  const rows = (await admin`SELECT count(*)::int AS n FROM retention_runs`) as Count[];
  return rows[0]!.n;
}

// Enable the WHOLE-engine per-tenant flag on the OWNER (RLS-exempt) connection — the same path withPlatformTx
// uses, minus the audit row these engine tests don't need. A tenant override wins outright (evaluateFlag), so the
// global def can stay OFF; the def row is created first only to satisfy the tenant_feature_flags → feature_flags FK.
async function enableEngineFlag(tenantId: string): Promise<void> {
  await db.db.transaction(async (tx) => {
    await db.featureFlagRepository.upsert(tx, {
      key: RETENTION_ENGINE_FLAG_KEY,
      description: "itest: retention engine gate",
    });
    await db.featureFlagRepository.setTenantOverride(tx, RETENTION_ENGINE_FLAG_KEY, tenantId, true);
  });
}

// Flip a class's policy via the SHIPPED upsert (owner path — under FORCE RLS the app role has no write policy).
async function setPolicyMode(
  dataClass: RetentionDataClass,
  ttlDays: number,
  mode: "disabled" | "shadow" | "enforce",
): Promise<void> {
  await db.db.transaction((tx) =>
    db.retentionClassPolicyRepository.upsertPolicy(tx, { dataClass, ttlDays, mode }),
  );
}

// The newest run row for a tenant+class (RLS-scoped read via the shipped repo; beforeEach clears runs so this is
// the run from the sweep under test). Returns undefined when no run was recorded for the class.
async function latestRun(tenantId: string, dataClass: RetentionDataClass) {
  const rows = await db.withTenantTx({ tenantId }, (tx) =>
    db.retentionRunRepository.recentRuns(tx, { dataClass, limit: 1 }),
  );
  return rows[0];
}

beforeAll(async () => {
  dbHandle = await startItestDb("retention");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  // env is set above, BEFORE these dynamic imports load @leadwolf/config / the db singleton (and the core sweep,
  // which imports @leadwolf/db transitively — same singleton). Core is reached via the source barrel, NOT the
  // package name, to avoid a packages/db → @leadwolf/core devDep (the Turbo ^build cycle); mirrors the other
  // core-driven itests (e.g. trackingIngest.itest.ts).
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

// ── A. RLS / access posture ─────────────────────────────────────────────────────────────────────────────────
describe("retention control plane: RLS / access posture", () => {
  const scopeA = (): Scope => ({ tenantId: tenantA, workspaceId: wsA });

  test("A1: app role can SELECT the seeded policy defaults but can never write one", async () => {
    // SELECT: the migration seeds the 12 DEFAULT_RETENTION_POLICIES; the app role reads them all (USING true).
    const policies = await db.withTenantTx(scopeA(), (tx) =>
      db.retentionClassPolicyRepository.listPolicies(tx),
    );
    expect(policies).toHaveLength(12);
    const verif = policies.find((p) => p.dataClass === "verification_jobs");
    expect(verif?.ttlDays).toBe(730);
    expect(verif?.mode).toBe("shadow");

    // INSERT is REJECTED under FORCE RLS (no INSERT policy → WITH CHECK denies → error).
    await expect(
      db.withTenantTx(scopeA(), (tx) =>
        tx
          .insert(db.schema.retentionClassPolicies)
          .values({ dataClass: "itest_blocked_class", ttlDays: 1, mode: "shadow" }),
      ),
    ).rejects.toThrow();

    // UPDATE / DELETE affect ZERO rows (no UPDATE/DELETE policy → no rows are visible to the command).
    const updated = await db.withTenantTx(scopeA(), (tx) =>
      tx.update(db.schema.retentionClassPolicies).set({ mode: "enforce" }).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await db.withTenantTx(scopeA(), (tx) =>
      tx.delete(db.schema.retentionClassPolicies).returning(),
    );
    expect(deleted).toHaveLength(0);

    // The owner connection confirms NOTHING changed: still 12 rows, none flipped to enforce, no bogus class.
    const [policyCount] = (await admin`
      SELECT count(*)::int AS n FROM retention_class_policies`) as Count[];
    expect(policyCount!.n).toBe(12);
    const [enforceCount] = (await admin`
      SELECT count(*)::int AS n FROM retention_class_policies WHERE mode = 'enforce'`) as Count[];
    expect(enforceCount!.n).toBe(0);
  });

  test("A2: retention_runs is per-tenant + append-only (no update/delete)", async () => {
    // Tenant A appends a run via the shipped repo (RLS WITH CHECK pins tenant_id to the GUC tenant).
    await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.retentionRunRepository.recordRun(tx, {
        tenantId: tenantA,
        dataClass: "verification_jobs",
        mode: "shadow",
        candidateCount: 42,
        deletedCount: 0,
        cutoff: daysBeforeNow(730),
        runStartedAt: NOW,
        runFinishedAt: NOW,
      }),
    );

    // A reads its own run; B (cross-tenant) sees nothing (RLS), while the owner confirms the row exists.
    const runsA = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.retentionRunRepository.recentRuns(tx),
    );
    expect(runsA).toHaveLength(1);
    expect(runsA[0]!.candidateCount).toBe(42);
    const runsB = await db.withTenantTx({ tenantId: tenantB }, (tx) =>
      db.retentionRunRepository.recentRuns(tx),
    );
    expect(runsB).toHaveLength(0);
    expect(await countRuns()).toBe(1);

    // The app role can never mutate or remove a run — UPDATE / DELETE affect ZERO rows (append-only trail).
    const updated = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      tx.update(db.schema.retentionRuns).set({ candidateCount: 999 }).returning(),
    );
    expect(updated).toHaveLength(0);
    const removed = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      tx.delete(db.schema.retentionRuns).returning(),
    );
    expect(removed).toHaveLength(0);

    // Owner confirms the run is intact and unchanged.
    const [cnt] = (await admin`SELECT count(*)::int AS n FROM retention_runs`) as Count[];
    expect(cnt!.n).toBe(1);
    const [val] = (await admin`SELECT candidate_count AS n FROM retention_runs`) as Count[];
    expect(val!.n).toBe(42);
    // Leave the table clean for the sweep suite below (its own beforeEach also clears it).
    await admin`DELETE FROM retention_runs`;
  });
});

// ── B. The sweep — gates + shadow/enforce + tenant isolation ────────────────────────────────────────────────
describe("retention sweep: gates, shadow/enforce, tenant isolation", () => {
  const scopeA = (): Scope => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = (): Scope => ({ tenantId: tenantB, workspaceId: wsB });

  // Deterministic start state for every case: no runs, no seeded class rows, no flag override, all policies back
  // to the shipped `shadow` default (B5/B6 flip some to enforce). import_jobs cascades to its chunks + rows.
  beforeEach(async () => {
    await admin`DELETE FROM retention_runs`;
    await admin`DELETE FROM import_jobs`;
    await admin`DELETE FROM verification_jobs`;
    await admin`DELETE FROM data_quality_snapshots`;
    await admin`DELETE FROM activities`;
    await admin`DELETE FROM contacts`; // cascades to any activities; seeded only by the activities cases (B8–B10)
    await admin`DELETE FROM tenant_feature_flags`;
    await admin`UPDATE retention_class_policies SET mode = 'shadow'`;
  });

  test("B3: flag OFF (default) - enabled:false, records nothing, deletes nothing", async () => {
    await seedVerificationJobs(scopeA(), VERIF_OLD, 3);
    await seedImportJobRows(scopeA(), IMPORT_OLD, 2);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });

    expect(result.enabled).toBe(false);
    expect(result.classesRecorded).toBe(0);
    expect(result.totalCandidates).toBe(0);
    expect(result.totalDeleted).toBe(0);
    // No audit rows, and the OLD rows are all still present (the outermost gate skipped the tenant entirely).
    expect(await countRuns()).toBe(0);
    expect(await countVerification(tenantA)).toBe(3);
    expect(await countImportRows(wsA)).toBe(2);
  });

  test("B4: flag ON, shadow counts OLD rows only and deletes nothing", async () => {
    await enableEngineFlag(tenantA);
    // 3 expired + 2 fresh verification_jobs; 4 expired + 1 fresh import_job_rows.
    await seedVerificationJobs(scopeA(), VERIF_OLD, 3);
    await seedVerificationJobs(scopeA(), VERIF_FRESH, 2);
    await seedImportJobRows(scopeA(), IMPORT_OLD, 4);
    await seedImportJobRows(scopeA(), IMPORT_FRESH, 1);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });

    expect(result.enabled).toBe(true);
    // One run per eligible WIRED class (the 6 v1 classes + activities, all finite ttl + default shadow mode).
    expect(result.classesRecorded).toBe(7);
    expect(await countRuns()).toBe(7);
    expect(result.totalDeleted).toBe(0);
    // Only the OLD rows are candidates (fresh, newer-than-cutoff rows are excluded): 3 + 4 = 7. No activities are
    // seeded here, so the activities run contributes 0 candidates — its own coverage is B8/B9/B10.
    expect(result.totalCandidates).toBe(7);

    const verifRun = await latestRun(tenantA, "verification_jobs");
    expect(verifRun?.mode).toBe("shadow");
    expect(verifRun?.candidateCount).toBe(3);
    expect(verifRun?.deletedCount).toBe(0);
    expect(verifRun?.cutoff).not.toBeNull();

    const importRun = await latestRun(tenantA, "import_job_rows");
    expect(importRun?.candidateCount).toBe(4);
    expect(importRun?.deletedCount).toBe(0);

    // A class with no rows still records a run, with a zero candidate count (email_event + activities here).
    const emailRun = await latestRun(tenantA, "email_event");
    expect(emailRun?.candidateCount).toBe(0);
    const activitiesRun = await latestRun(tenantA, "activities");
    expect(activitiesRun?.mode).toBe("shadow");
    expect(activitiesRun?.candidateCount).toBe(0);

    // SHADOW deletes NOTHING — every seeded row (old AND fresh) is still present.
    expect(await countVerification(tenantA)).toBe(5);
    expect(await countImportRows(wsA)).toBe(5);
  });

  test("B5: flag ON + enforce deletes OLD rows, keeps fresh", async () => {
    await enableEngineFlag(tenantA);
    await setPolicyMode("verification_jobs", 730, "enforce");
    await setPolicyMode("import_job_rows", 365, "enforce");
    await seedVerificationJobs(scopeA(), VERIF_OLD, 3);
    await seedVerificationJobs(scopeA(), VERIF_FRESH, 2);
    await seedImportJobRows(scopeA(), IMPORT_OLD, 4);
    await seedImportJobRows(scopeA(), IMPORT_FRESH, 1);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });

    expect(result.enabled).toBe(true);
    expect(result.classesRecorded).toBe(7);
    expect(result.totalDeleted).toBe(7); // 3 verification + 4 import OLD rows purged (activities stays shadow)

    const verifRun = await latestRun(tenantA, "verification_jobs");
    expect(verifRun?.mode).toBe("enforce");
    expect(verifRun?.candidateCount).toBe(3);
    expect(verifRun?.deletedCount).toBe(3);

    const importRun = await latestRun(tenantA, "import_job_rows");
    expect(importRun?.mode).toBe("enforce");
    expect(importRun?.candidateCount).toBe(4);
    expect(importRun?.deletedCount).toBe(4);

    // Only the fresh (newer-than-cutoff) rows survive; the OLD ones are gone.
    expect(await countVerification(tenantA)).toBe(2);
    expect(await countImportRows(wsA)).toBe(1);
  });

  test("B6: enforce is tenant-isolated (A never touches B)", async () => {
    await enableEngineFlag(tenantA); // only A is flag-enabled; the sweep is invoked for A only
    await setPolicyMode("verification_jobs", 730, "enforce");
    await setPolicyMode("import_job_rows", 365, "enforce");
    // OLD (expired) rows for BOTH tenants — B's are older than the cutoff too, so only the tenant predicate (not
    // RLS — the count/delete run on the owner connection) keeps them safe.
    await seedVerificationJobs(scopeA(), VERIF_OLD, 3);
    await seedImportJobRows(scopeA(), IMPORT_OLD, 2);
    await seedVerificationJobs(scopeB(), VERIF_OLD, 5);
    await seedImportJobRows(scopeB(), IMPORT_OLD, 3);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });
    expect(result.enabled).toBe(true);
    expect(result.totalDeleted).toBe(5); // 3 + 2 of tenant A only

    // Tenant A purged; tenant B completely untouched.
    expect(await countVerification(tenantA)).toBe(0);
    expect(await countImportRows(wsA)).toBe(0);
    expect(await countVerification(tenantB)).toBe(5);
    expect(await countImportRows(wsB)).toBe(3);

    // A's run audit reflects its own deletes; tenant B has NO run rows (it was never swept).
    expect((await latestRun(tenantA, "verification_jobs"))?.deletedCount).toBe(3);
    expect((await latestRun(tenantA, "import_job_rows"))?.deletedCount).toBe(2);
    const runsB = await db.withTenantTx({ tenantId: tenantB }, (tx) =>
      db.retentionRunRepository.recentRuns(tx),
    );
    expect(runsB).toHaveLength(0);
  });

  test("B7: a null-ttl / not-wired class is skipped (no run)", async () => {
    await enableEngineFlag(tenantA);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });
    expect(result.enabled).toBe(true);
    // The 7 WIRED classes are recorded; the rest are gated out — null-ttl (contacts, audit_log) OR not-yet-wired.
    expect(result.classesRecorded).toBe(7);
    expect(await latestRun(tenantA, "contacts")).toBeUndefined();
    expect(await latestRun(tenantA, "audit_log")).toBeUndefined();
    // A deferred v2 class with a FINITE ttl (contact_reveals 180d) is still gated out — not wired, so no run.
    expect(await latestRun(tenantA, "contact_reveals")).toBeUndefined();
  });

  // ── activities (the newly-wired v2 leaf, aged on occurred_at) — shadow / enforce / tenant-isolation ──────────
  test("B8: flag ON, shadow counts OLD activities only and deletes nothing", async () => {
    await enableEngineFlag(tenantA);
    const contactA = await seedContact(scopeA());
    // 3 expired + 2 fresh activities (ttl 365d, aged on occurred_at).
    await seedActivities(scopeA(), contactA, ACTIVITY_OLD, 3);
    await seedActivities(scopeA(), contactA, ACTIVITY_FRESH, 2);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });
    expect(result.enabled).toBe(true);
    expect(result.totalDeleted).toBe(0);

    const activitiesRun = await latestRun(tenantA, "activities");
    expect(activitiesRun?.mode).toBe("shadow");
    expect(activitiesRun?.candidateCount).toBe(3); // only the OLD rows; the 2 fresh are newer than the cutoff
    expect(activitiesRun?.deletedCount).toBe(0);
    expect(activitiesRun?.cutoff).not.toBeNull();

    // SHADOW deletes NOTHING — every seeded activity (old AND fresh) is still present.
    expect(await countActivities(tenantA)).toBe(5);
  });

  test("B9: flag ON + enforce deletes OLD activities, keeps fresh", async () => {
    await enableEngineFlag(tenantA);
    await setPolicyMode("activities", 365, "enforce");
    const contactA = await seedContact(scopeA());
    await seedActivities(scopeA(), contactA, ACTIVITY_OLD, 3);
    await seedActivities(scopeA(), contactA, ACTIVITY_FRESH, 2);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });
    expect(result.enabled).toBe(true);
    expect(result.totalDeleted).toBe(3); // only activities is in enforce — the 3 OLD activity rows purged

    const activitiesRun = await latestRun(tenantA, "activities");
    expect(activitiesRun?.mode).toBe("enforce");
    expect(activitiesRun?.candidateCount).toBe(3);
    expect(activitiesRun?.deletedCount).toBe(3);

    // Only the fresh (newer-than-cutoff) activities survive; the OLD ones are gone (lockstep with the count).
    expect(await countActivities(tenantA)).toBe(2);
  });

  test("B10: enforce of activities is tenant-isolated (A never touches B)", async () => {
    await enableEngineFlag(tenantA); // only A is flag-enabled; the sweep is invoked for A only
    await setPolicyMode("activities", 365, "enforce");
    const contactA = await seedContact(scopeA());
    const contactB = await seedContact(scopeB());
    // OLD activities for BOTH tenants — B's are older than the cutoff too, so ONLY the explicit tenant predicate
    // (not RLS — the count/delete run on the owner connection) keeps them safe.
    await seedActivities(scopeA(), contactA, ACTIVITY_OLD, 3);
    await seedActivities(scopeB(), contactB, ACTIVITY_OLD, 5);

    const result = await core.runRetentionSweepForTenant({ tenantId: tenantA, now: NOW });
    expect(result.enabled).toBe(true);
    expect(result.totalDeleted).toBe(3); // tenant A only

    // Tenant A purged; tenant B completely untouched.
    expect(await countActivities(tenantA)).toBe(0);
    expect(await countActivities(tenantB)).toBe(5);
    expect((await latestRun(tenantA, "activities"))?.deletedCount).toBe(3);
    const runsB = await db.withTenantTx({ tenantId: tenantB }, (tx) =>
      db.retentionRunRepository.recentRuns(tx),
    );
    expect(runsB).toHaveLength(0);
  });
});
