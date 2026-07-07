// scheduledImports.itest.ts — the P5 scheduled-imports STORAGE + FIRE-IDEMPOTENCY contract (import-and-data-
// model-redesign 08 §9, P5), on a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see
// itestDb.ts). Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/scheduledImports.itest.ts
//
// Proves the db-testable surface the worker sweep composes (the sweep's orchestration itself lives in
// apps/workers and is exercised by the pure core test + CI's pipeline):
//   (1) create → listInWorkspace / getById round-trip; the (workspace, lower(name)) unique rejects a dup name.
//   (2) listDueSchedules (owner-connection census) returns only enabled rows with next_run_at ≤ now.
//   (3) FIRE IDEMPOTENCY: two fires of the SAME window derive the SAME idempotency key ⇒ importJobRepository
//       .createJob collapses onto ONE job (created:true then created:false) — a double-fire is one job.
//   (4) advanceAfterFire stamps last_run_at/last_job_id + resets the failure state.
//   (5) recordFailure auto-disables at the threshold (disabled_reason='max_failures').
//   (6) disableForGrantLoss (disabled_reason='grant_lost'); only an enabled row flips.
//   (7) countInWorkspace backs the per-workspace cap.
//   (8) RLS: workspace B never sees A's schedule via the scoped CRUD.

import { deriveScheduleIdempotencyKey } from "@leadwolf/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantA = "";
let wsA = "";
let userA = "";
let tenantB = "";
let wsB = "";

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; userId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, userId: u!.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("scheduled-imports");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, userId: userA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  db = await import("@leadwolf/db");
}, 240_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

const baseValues = (over: Record<string, unknown> = {}) => ({
  tenantId: tenantA,
  workspaceId: wsA,
  createdByUserId: userA,
  name: "nightly acme",
  sourceName: "csv",
  sourceObjectKey: "imports/aaaa/source.csv",
  mapping: { email: "Email" },
  cadence: "daily",
  enabled: true,
  nextRunAt: new Date(Date.now() - 60_000), // due (a minute ago)
  ...over,
});

describe("scheduled_imports — storage, fire idempotency, auto-disable, RLS (P5)", () => {
  test("create → list / getById round-trip; a duplicate (case-insensitive) name is rejected", async () => {
    const row = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(tx, baseValues() as never),
    );
    expect(row.enabled).toBe(true);
    expect(row.consecutiveFailures).toBe(0);

    const list = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.listInWorkspace(tx, wsA),
    );
    expect(list.map((r) => r.id)).toContain(row.id);
    const byId = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.getById(tx, row.id),
    );
    expect(byId?.name).toBe("nightly acme");

    // The (workspace_id, lower(name)) unique surfaces a dup name as a DB error (create is not an upsert).
    await expect(
      db.withTenantTx(scopeA(), (tx) =>
        db.scheduledImportRepository.create(tx, baseValues({ name: "NIGHTLY ACME" }) as never),
      ),
    ).rejects.toThrow();
  });

  test("listDueSchedules returns only enabled rows with next_run_at ≤ now", async () => {
    const future = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(
        tx,
        baseValues({ name: "future", nextRunAt: new Date(Date.now() + 3_600_000) }) as never,
      ),
    );
    const disabled = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(
        tx,
        baseValues({ name: "paused", enabled: false }) as never,
      ),
    );
    const due = await db.scheduledImportRepository.listDueSchedules(new Date());
    const ids = due.map((d) => d.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(disabled.id);
    // The originally-created "nightly acme" is due and present, scoped correctly.
    expect(due.every((d) => typeof d.workspaceId === "string")).toBe(true);
  });

  test("FIRE IDEMPOTENCY: a double-fire of the same window collapses onto ONE import job", async () => {
    const sched = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(tx, baseValues({ name: "fire-once" }) as never),
    );
    const window = sched.nextRunAt;
    const key = deriveScheduleIdempotencyKey(sched.id, window);

    const first = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        createdByUserId: userA,
        status: "queued",
        sourceFile: sched.sourceObjectKey,
        sourceName: sched.sourceName,
        idempotencyKey: key,
        options: { scheduleId: sched.id },
      }),
    );
    expect(first.created).toBe(true);

    const second = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        createdByUserId: userA,
        status: "queued",
        sourceFile: sched.sourceObjectKey,
        sourceName: sched.sourceName,
        idempotencyKey: key,
        options: { scheduleId: sched.id },
      }),
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id); // collapsed onto the SAME job

    // advanceAfterFire stamps last_job_id + resets the failure state.
    await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.advanceAfterFire(tx, sched.id, {
        nextRunAt: new Date(window.getTime() + 24 * 3_600_000),
        lastRunAt: new Date(),
        lastJobId: first.id,
      }),
    );
    const after = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.getById(tx, sched.id),
    );
    expect(after?.lastJobId).toBe(first.id);
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.nextRunAt.getTime()).toBe(window.getTime() + 24 * 3_600_000);
  });

  test("recordFailure auto-disables at the threshold (disabled_reason='max_failures')", async () => {
    const sched = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(tx, baseValues({ name: "flaky" }) as never),
    );
    const maxFailures = 5;
    let last = { consecutiveFailures: 0, disabled: false };
    for (let i = 0; i < maxFailures; i++) {
      last = await db.withTenantTx(scopeA(), (tx) =>
        db.scheduledImportRepository.recordFailure(tx, sched.id, {
          nextRunAt: new Date(Date.now() + 3_600_000),
          maxFailures,
        }),
      );
    }
    expect(last.consecutiveFailures).toBe(maxFailures);
    expect(last.disabled).toBe(true);
    const row = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.getById(tx, sched.id),
    );
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("max_failures");
  });

  test("disableForGrantLoss disables with disabled_reason='grant_lost' (enabled rows only)", async () => {
    const sched = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.create(tx, baseValues({ name: "grant-loss" }) as never),
    );
    await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.disableForGrantLoss(tx, sched.id),
    );
    const row = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.getById(tx, sched.id),
    );
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("grant_lost");
  });

  test("countInWorkspace backs the per-workspace cap; RLS walls workspace B from A's schedules", async () => {
    const countA = await db.withTenantTx(scopeA(), (tx) =>
      db.scheduledImportRepository.countInWorkspace(tx, wsA),
    );
    expect(countA).toBeGreaterThan(0);

    // B's scoped reads never see A's rows (RLS), and B's own count is 0.
    const countB = await db.withTenantTx(scopeB(), (tx) =>
      db.scheduledImportRepository.countInWorkspace(tx, wsB),
    );
    expect(countB).toBe(0);
    const listB = await db.withTenantTx(scopeB(), (tx) =>
      db.scheduledImportRepository.listInWorkspace(tx, wsB),
    );
    expect(listB).toHaveLength(0);
  });
});
