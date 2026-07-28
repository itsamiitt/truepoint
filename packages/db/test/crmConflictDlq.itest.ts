// crmConflictDlq.itest.ts — the conflict review queue + the poison-job DLQ against a real Postgres
// (crm-sync 00 §4.7 / §4.8). Run in its OWN process:
//   bun test ./packages/db/test/crmConflictDlq.itest.ts
//
// Both tables have unit tests for their PURE guards (masking, error classification). Those prove the
// functions behave; they cannot prove what actually lands in the column, that RLS holds, or that the
// append-only wall is real. This file covers exactly that gap:
//
//   - PII is masked IN THE DATABASE, not merely on the way past a helper. A future caller that bypassed
//     maskIfPii would still pass the unit tests; it fails here.
//   - Both tables are workspace-isolated, and the DLQ is APPEND-ONLY for leadwolf_app — asserted as
//     "affects zero rows", because an absent UPDATE/DELETE policy under FORCE RLS denies SILENTLY.
//   - `resolve` transitions only an OPEN row, so two reviewers cannot both decide the same conflict.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let ownerA = "";
let connA = "";
let tenantB = "";
let wsB = "";
let connB = "";

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

async function seed(slug: string) {
  const t = one<{ id: string }>(
    await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`,
    "tenant",
  );
  const u = one<{ id: string }>(
    await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`,
    "user",
  );
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${t.id}, ${u.id}, true)`;
  const w = one<{ id: string }>(
    await admin`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${t.id}, ${slug}, ${slug}, true, ${u.id}) RETURNING id`,
    "workspace",
  );
  const c = one<{ id: string }>(
    await admin`
      INSERT INTO crm_connections (tenant_id, workspace_id, provider, status, external_account_id)
      VALUES (${t.id}, ${w.id}, 'salesforce', 'connected', ${`ORG-${slug}`}) RETURNING id`,
    "connection",
  );
  return { tenantId: t.id, wsId: w.id, ownerId: u.id, connectionId: c.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("crmConflictDlq");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");

  const a = await seed("acme");
  tenantA = a.tenantId;
  wsA = a.wsId;
  ownerA = a.ownerId;
  connA = a.connectionId;
  const b = await seed("globex");
  tenantB = b.tenantId;
  wsB = b.wsId;
  connB = b.connectionId;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("crm_sync_conflicts — PII masking lands IN THE COLUMN", () => {
  test("an email conflict stores a masked stub, never the address", async () => {
    // The unit test proves maskIfPii returns a stub. This proves the repository actually applies it on the
    // write path — a caller that bypassed the helper would still pass the unit test and fail here.
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.recordMany(tx, [
        {
          tenantId: tenantA,
          workspaceId: wsA,
          connectionId: connA,
          objectType: "contact",
          field: "email",
          tpValue: "dana.scully@acme.com",
          crmValue: "d.scully@acme.com",
        },
      ]),
    );

    const row = one<{ tp_value: string; crm_value: string }>(
      await admin`
        SELECT tp_value, crm_value FROM crm_sync_conflicts
        WHERE connection_id = ${connA} AND field = 'email'`,
      "conflict",
    );
    expect(row.tp_value).not.toContain("dana");
    expect(row.tp_value).not.toContain("acme.com");
    expect(row.crm_value).not.toContain("scully");
    expect(row.tp_value.startsWith("•••")).toBe(true);
  });

  test("a non-PII scalar stays readable so a reviewer can actually arbitrate", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.recordMany(tx, [
        {
          tenantId: tenantA,
          workspaceId: wsA,
          connectionId: connA,
          objectType: "contact",
          field: "jobTitle",
          tpValue: "VP of Sales",
          crmValue: "Director",
        },
      ]),
    );
    const row = one<{ tp_value: string; crm_value: string }>(
      await admin`
        SELECT tp_value, crm_value FROM crm_sync_conflicts
        WHERE connection_id = ${connA} AND field = 'jobTitle'`,
      "conflict",
    );
    expect(row.tp_value).toBe("VP of Sales");
    expect(row.crm_value).toBe("Director");
  });

  test("an empty list inserts nothing, so a caller can pass a planner's array unconditionally", async () => {
    const n = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.recordMany(tx, []),
    );
    expect(n).toBe(0);
  });
});

describe("crm_sync_conflicts — arbitration is single-shot and attributed", () => {
  let conflictId = "";

  test("resolve closes an OPEN row and records who decided", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.recordMany(tx, [
        {
          tenantId: tenantA,
          workspaceId: wsA,
          connectionId: connA,
          objectType: "contact",
          field: "department",
          tpValue: "Sales",
          crmValue: "Revenue",
        },
      ]),
    );
    conflictId = one<{ id: string }>(
      await admin`
        SELECT id FROM crm_sync_conflicts WHERE connection_id = ${connA} AND field = 'department'`,
      "conflict",
    ).id;

    const ok = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.resolve(tx, conflictId, "resolved", ownerA),
    );
    expect(ok).toBe(true);

    const row = one<{ status: string; resolved_by_user_id: string; resolved_at: Date }>(
      await admin`
        SELECT status, resolved_by_user_id, resolved_at FROM crm_sync_conflicts WHERE id = ${conflictId}`,
      "conflict",
    );
    expect(row.status).toBe("resolved");
    // Arbitration is a human decision; the trail should say whose.
    expect(row.resolved_by_user_id).toBe(ownerA);
    expect(row.resolved_at).not.toBeNull();
  });

  test("a SECOND resolve returns false — a stale UI cannot overwrite the first reviewer", async () => {
    const again = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.resolve(tx, conflictId, "ignored", ownerA),
    );
    expect(again).toBe(false);
    const row = one<{ status: string }>(
      await admin`SELECT status FROM crm_sync_conflicts WHERE id = ${conflictId}`,
      "conflict",
    );
    expect(row.status).toBe("resolved"); // the first decision stands
  });

  test("a foreign workspace cannot resolve another's conflict", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.recordMany(tx, [
        {
          tenantId: tenantA,
          workspaceId: wsA,
          connectionId: connA,
          objectType: "contact",
          field: "seniorityLevel",
          tpValue: "vp",
          crmValue: "director",
        },
      ]),
    );
    const id = one<{ id: string }>(
      await admin`
        SELECT id FROM crm_sync_conflicts WHERE connection_id = ${connA} AND field = 'seniorityLevel'`,
      "conflict",
    ).id;

    const ok = await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmSyncConflictRepository.resolve(tx, id, "ignored", ownerA),
    );
    expect(ok).toBe(false); // RLS filtered the row out of the UPDATE entirely
    const row = one<{ status: string }>(
      await admin`SELECT status FROM crm_sync_conflicts WHERE id = ${id}`,
      "conflict",
    );
    expect(row.status).toBe("open");
  });

  test("listOpen is workspace-scoped and excludes closed rows", async () => {
    const listA = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncConflictRepository.listOpen(tx, 100),
    );
    expect(listA.length).toBeGreaterThan(0);
    expect(listA.some((c) => c.id === conflictId)).toBe(false); // resolved earlier

    const listB = await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmSyncConflictRepository.listOpen(tx, 100),
    );
    expect(listB).toHaveLength(0); // workspace B has raised none
  });
});

describe("crm_sync_dead_letter — the durable, PII-free poison queue", () => {
  test("records a row with the detail SCRUBBED in the column", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmDeadLetterRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connA,
        queue: "crm_sync_push",
        direction: "outbound",
        objectType: "contact",
        errorClass: "validation",
        errorDetail: "could not update dana.scully@acme.com (phone 14155552671)",
        attempts: 5,
      }),
    );

    const row = one<{ error_detail: string; error_class: string; attempts: number }>(
      await admin`
        SELECT error_detail, error_class, attempts FROM crm_sync_dead_letter
        WHERE connection_id = ${connA}`,
      "dlq",
    );
    // A dead-letter row is read by staff across tenants. If it carried the record that failed, the DLQ
    // would quietly become a cross-tenant copy of customer data with its own retention story.
    expect(row.error_detail).not.toContain("dana");
    expect(row.error_detail).not.toContain("acme.com");
    expect(row.error_detail).not.toContain("14155552671");
    expect(row.error_detail).toContain("[email]");
    expect(row.error_class).toBe("validation");
    expect(row.attempts).toBe(5);
  });

  test("is APPEND-ONLY for the app role — UPDATE affects zero rows", async () => {
    // The absence of an UPDATE policy under FORCE RLS denies SILENTLY: the statement succeeds and matches
    // nothing. Asserting "threw" would be testing the wrong manifestation (and would fail).
    const affected = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const rows = await tx`
        UPDATE crm_sync_dead_letter SET status = 'resolved'
        WHERE workspace_id = ${wsA} RETURNING id`;
      return rows.length;
    });
    expect(affected).toBe(0);

    const row = one<{ status: string }>(
      await admin`SELECT status FROM crm_sync_dead_letter WHERE connection_id = ${connA}`,
      "dlq",
    );
    expect(row.status).toBe("open"); // the staff replay console mutates this on the OWNER path, not here
  });

  test("is APPEND-ONLY for the app role — DELETE affects zero rows", async () => {
    const affected = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const rows = await tx`
        DELETE FROM crm_sync_dead_letter WHERE workspace_id = ${wsA} RETURNING id`;
      return rows.length;
    });
    expect(affected).toBe(0);
    const n = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_sync_dead_letter WHERE workspace_id = ${wsA}`,
      "count",
    );
    expect(n.n).toBeGreaterThan(0);
  });

  test("listOpen and the connection count are workspace-scoped", async () => {
    const listA = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmDeadLetterRepository.listOpen(tx, 100),
    );
    expect(listA.length).toBeGreaterThan(0);

    const listB = await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmDeadLetterRepository.listOpen(tx, 100),
    );
    expect(listB).toHaveLength(0);

    // A foreign connection id read from the WRONG workspace counts zero — RLS, not a WHERE clause.
    const crossCount = await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmDeadLetterRepository.countOpenForConnection(tx, connA),
    );
    expect(crossCount).toBe(0);
  });

  test("an unfamiliar reason lands as 'unknown' rather than failing the closed CHECK", async () => {
    // The last chance to record a failure must not itself fail. classifyCrmError can only emit values the
    // column accepts; this proves that end-to-end against the real constraint.
    const cls = dbmod.classifyCrmError("some_future_outcome_nobody_planned");
    await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmDeadLetterRepository.record(tx, {
        tenantId: tenantB,
        workspaceId: wsB,
        connectionId: connB,
        queue: "crm_sync_inbound",
        errorClass: cls,
        errorDetail: "something nobody anticipated",
        attempts: 3,
      }),
    );
    const row = one<{ error_class: string }>(
      await admin`SELECT error_class FROM crm_sync_dead_letter WHERE connection_id = ${connB}`,
      "dlq",
    );
    expect(row.error_class).toBe("unknown");
  });
});
