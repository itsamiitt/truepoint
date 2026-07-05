// jobVisibility.itest.ts — the CROSS-USER isolation class for job surfaces (import-and-data-model-redesign
// 10 §Testing, T-V1–T-V4; the G01 fix), on a real Postgres 16 (Testcontainers by default, or
// ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module singleton):
// `bun test ./packages/db/test/jobVisibility.itest.ts`.
//
// This is a NEW test class beyond cross-tenant: one workspace, two members A and B — the tenant wall does
// NOT separate them; only the jobVisibility predicate does. Proves, per surface (import / reveal /
// enrichment / recentBatches):
//   T-V1  scoped member A never sees B's jobs; A's detail-read of B's job id is null (⇒ 404 at the edge).
//   T-V2  scoped admin sees A's + B's + system (null-creator) rows, with creator attribution populated.
//   T-V3  IDOR probe: a foreign-user id and an absent id are INDISTINGUISHABLE (both null).
//   T-V4  flag-off parity: a scoped:false viewer reads exactly the legacy workspace-wide set (the rollback
//         lever proven at the repo layer; the route layer adds no predicate of its own — 10 §4.2 rule 3).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JobViewer } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantId = "";
let wsId = "";
let userA = "";
let userB = "";
// Seeded job ids per surface.
let importA = "";
let importB = "";
let revealA = "";
let revealB = "";
let enrichA = "";
let enrichB = "";
let enrichSystem = "";

const scope = () => ({ tenantId, workspaceId: wsId });
const viewerA = (over: Partial<JobViewer> = {}): JobViewer => ({
  userId: userA,
  role: "member",
  scoped: true,
  ...over,
});
const adminViewer = (): JobViewer => ({ userId: userB, role: "admin", scoped: true });

beforeAll(async () => {
  dbHandle = await startItestDb("job-visibility");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme', 'acme', 100) RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [ua] = await admin`
    INSERT INTO users (email, full_name) VALUES ('alice@acme.test', 'Alice Adams') RETURNING id`;
  userA = (ua as { id: string }).id;
  // B has NO full_name — attribution must fall back to the email (10 §2.1: HubSpot renders name + email).
  const [ub] = await admin`INSERT INTO users (email) VALUES ('bob@acme.test') RETURNING id`;
  userB = (ub as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${userA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${userA}) RETURNING id`;
  wsId = (w as { id: string }).id;

  db = await import("@leadwolf/db");

  // ONE workspace, TWO creators — the cross-user fixture the cross-tenant suites never exercise.
  importA = (
    await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId,
        workspaceId: wsId,
        createdByUserId: userA,
        sourceFile: "s3://acme/a.csv",
        sourceName: "a.csv",
      }),
    )
  ).id;
  importB = (
    await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId,
        workspaceId: wsId,
        createdByUserId: userB,
        sourceFile: "s3://acme/b.csv",
        sourceName: "b.csv",
      }),
    )
  ).id;

  revealA = (
    await db.revealJobRepository.createJob(scope(), {
      tenantId,
      workspaceId: wsId,
      createdByUserId: userA,
      revealType: "email",
      totalContacts: 1,
      creditEstimate: 1,
    })
  ).id;
  revealB = (
    await db.revealJobRepository.createJob(scope(), {
      tenantId,
      workspaceId: wsId,
      createdByUserId: userB,
      revealType: "email",
      totalContacts: 1,
      creditEstimate: 1,
    })
  ).id;

  enrichA = (
    await db.enrichmentJobRepository.createJob(scope(), {
      tenantId,
      workspaceId: wsId,
      createdByUserId: userA,
      sourceFile: "s3://acme/ea.csv",
      sourceName: "ea.csv",
    })
  ).id;
  enrichB = (
    await db.enrichmentJobRepository.createJob(scope(), {
      tenantId,
      workspaceId: wsId,
      createdByUserId: userB,
      sourceFile: "s3://acme/eb.csv",
      sourceName: "eb.csv",
    })
  ).id;
  // System/automation job: created_by_user_id NULL — nobody's "own"; elevated-only (10 §Edge cases).
  enrichSystem = (
    await db.enrichmentJobRepository.createJob(scope(), {
      tenantId,
      workspaceId: wsId,
      createdByUserId: null,
      sourceFile: "s3://acme/sys.csv",
      sourceName: "sys.csv",
    })
  ).id;

  // Provenance rows for the Recent Imports card: one contact + source_import per member.
  const [ca] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id) VALUES (${tenantId}, ${wsId}) RETURNING id`;
  const [cb] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id) VALUES (${tenantId}, ${wsId}) RETURNING id`;
  await db.withTenantTx(scope(), async (tx) => {
    await db.sourceImportRepository.append(tx, {
      tenantId,
      workspaceId: wsId,
      contactId: (ca as { id: string }).id,
      importedByUserId: userA,
      sourceName: "manual",
      sourceFile: "alice-upload.csv",
      rawData: {},
    });
    await db.sourceImportRepository.append(tx, {
      tenantId,
      workspaceId: wsId,
      contactId: (cb as { id: string }).id,
      importedByUserId: userB,
      sourceName: "manual",
      sourceFile: "bob-upload.csv",
      rawData: {},
    });
  });
}, 240_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("T-V1 cross-USER isolation — scoped member A never sees B's jobs, on every surface", () => {
  test("import list + detail", async () => {
    const jobs = await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.listJobs(tx, viewerA()),
    );
    expect(jobs.map((j) => j.id)).toEqual([importA]);
    const foreign = await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.getJob(tx, viewerA(), importB),
    );
    expect(foreign).toBeNull();
  });

  test("reveal list + detail", async () => {
    const jobs = await db.revealJobRepository.listJobs(scope(), viewerA());
    expect(jobs.map((j) => j.id)).toEqual([revealA]);
    expect(await db.revealJobRepository.getJob(scope(), viewerA(), revealB)).toBeNull();
  });

  test("enrichment list + detail (system rows excluded for members too)", async () => {
    const jobs = await db.enrichmentJobRepository.listJobs(scope(), viewerA());
    expect(jobs.map((j) => j.id)).toEqual([enrichA]);
    expect(await db.enrichmentJobRepository.getJob(scope(), viewerA(), enrichB)).toBeNull();
    expect(await db.enrichmentJobRepository.getJob(scope(), viewerA(), enrichSystem)).toBeNull();
  });

  test("recentBatches shows only A's own batches", async () => {
    const batches = await db.sourceImportRepository.recentBatches(scope(), viewerA());
    expect(batches.map((b) => b.sourceFile)).toEqual(["alice-upload.csv"]);
  });
});

describe("T-V2 admin override — elevated sees all rows with creator attribution", () => {
  test("enrichment: A's + B's + the system row, attributed", async () => {
    const jobs = await db.enrichmentJobRepository.listJobs(scope(), adminViewer());
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain(enrichA);
    expect(ids).toContain(enrichB);
    expect(ids).toContain(enrichSystem);
    const a = jobs.find((j) => j.id === enrichA)!;
    expect(a.createdByUserId).toBe(userA);
    expect(a.createdByDisplayName).toBe("Alice Adams");
    const b = jobs.find((j) => j.id === enrichB)!;
    expect(b.createdByDisplayName).toBe("bob@acme.test"); // no full_name ⇒ email fallback
    const sys = jobs.find((j) => j.id === enrichSystem)!;
    expect(sys.createdByUserId).toBeNull(); // renders "System" (UI concern)
    expect(sys.createdByDisplayName).toBeNull();
  });

  test("reveal + import + recentBatches: both members' rows visible", async () => {
    const reveal = await db.revealJobRepository.listJobs(scope(), adminViewer());
    expect(reveal.map((j) => j.id).sort()).toEqual([revealA, revealB].sort());
    const imports = await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.listJobs(tx, adminViewer()),
    );
    expect(imports.map((j) => j.id).sort()).toEqual([importA, importB].sort());
    const batches = await db.sourceImportRepository.recentBatches(scope(), adminViewer());
    expect(batches.map((b) => b.sourceFile).sort()).toEqual([
      "alice-upload.csv",
      "bob-upload.csv",
    ]);
  });
});

describe("T-V3 IDOR probe — foreign id and absent id are indistinguishable", () => {
  test("both resolve to null (⇒ identical 404s at the edge; no existence oracle)", async () => {
    const absentId = "00000000-0000-4000-8000-000000000000";
    const foreign = await db.revealJobRepository.getJob(scope(), viewerA(), revealB);
    const absent = await db.revealJobRepository.getJob(scope(), viewerA(), absentId);
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
    expect(foreign).toEqual(absent);
  });
});

describe("T-V4 flag-off parity — scoped:false reads the legacy workspace-wide set", () => {
  test("every surface returns the full workspace set for a plain member when the gate is off", async () => {
    const off = viewerA({ scoped: false });
    const imports = await db.withTenantTx(scope(), (tx) =>
      db.importJobRepository.listJobs(tx, off),
    );
    expect(imports.map((j) => j.id).sort()).toEqual([importA, importB].sort());

    const reveal = await db.revealJobRepository.listJobs(scope(), off);
    expect(reveal.map((j) => j.id).sort()).toEqual([revealA, revealB].sort());

    const enrich = await db.enrichmentJobRepository.listJobs(scope(), off);
    expect(enrich.map((j) => j.id).sort()).toEqual([enrichA, enrichB, enrichSystem].sort());

    const batches = await db.sourceImportRepository.recentBatches(scope(), off);
    expect(batches.map((b) => b.sourceFile).sort()).toEqual([
      "alice-upload.csv",
      "bob-upload.csv",
    ]);

    // Detail parity: B's job IS readable by A when the gate is off (the shipped behavior).
    expect(await db.revealJobRepository.getJob(scope(), off, revealB)).not.toBeNull();
    expect(await db.enrichmentJobRepository.getJob(scope(), off, enrichB)).not.toBeNull();
  });
});

describe("T-V5 share flag — shared_with_workspace widens list/detail for members (10 §2.3)", () => {
  test("a shared foreign job becomes visible to a scoped member in list AND detail", async () => {
    // No route writes this column yet (UX deferred, doc 14) — flip it as the DB owner, the way a future
    // share-verb would. B's reveal job becomes workspace-shared; B's other jobs stay private.
    await admin`UPDATE reveal_jobs SET shared_with_workspace = true WHERE id = ${revealB}`;

    const jobs = await db.revealJobRepository.listJobs(scope(), viewerA());
    expect(jobs.map((j) => j.id).sort()).toEqual([revealA, revealB].sort());
    expect(await db.revealJobRepository.getJob(scope(), viewerA(), revealB)).not.toBeNull();

    // Other surfaces are unaffected — the flag is per-row, not per-workspace.
    const enrich = await db.enrichmentJobRepository.listJobs(scope(), viewerA());
    expect(enrich.map((j) => j.id)).toEqual([enrichA]);
    // (Artifact reads stay creator-∪-elevated regardless of the share flag — 10 §2.1; the artifact
    // endpoint itself is Phase 1 (S-V5/S-I7), so T-V7's download-audit case lands there.)
  });
});
