// importDraft.itest.ts — S-I8's test gate (import-and-data-model-redesign 15 §T-P2, seq 35): T11 DRAFT
// LIFECYCLE at the repo/core seams (draft create → mapping save → preview cache → commit flip → the SAME
// engine run as the one-shot lands the identical contact end-state — parity is structural because commit
// enqueues the one-shot's exact ImportFastInput), the DRAFT-PINNED write guards behind the routes' 409
// matrix (updateDraftMapping / savePreviewSummary / deleteDraftJob all refuse a non-draft row), T12's
// draft half (the preview projection is NON-PII: codes + canonical columns + line numbers, never a row
// value; sample rows live only in the transient result), the 08 §7 history posture (drafts excluded by
// default, `drafts:'only'` opt-in), the commit-quota census exclusion, and the reaper census/delete pair.
// Real Postgres via Testcontainers (or ITEST_DATABASE_URL); no Redis (queue transport is proven by
// imports.queue.itest.ts). Run explicitly, own process:
//   bun test packages/db/test/importDraft.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("@leadwolf/core");
type Db = typeof import("@leadwolf/db");
let core: Core;
let dbm: Db;

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsDraft = ""; // draft lifecycle + preview workspace
let wsOneShot = ""; // one-shot parity twin
let wsDraftRun = ""; // draft-committed parity twin
let ownerA = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};

// 4 rows: 1 would-update (seeded below), 1 would-create, 1 within-file duplicate of it, 1 reject.
const PREVIEW_ROWS = [
  {
    Email: "existing@acme.com",
    "First Name": "Eve",
    "Last Name": "Original",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "new@acme.com",
    "First Name": "Nora",
    "Last Name": "Fresh",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "NEW@acme.com", // same identity key as row 1 (case-insensitive) ⇒ duplicate-in-file
    "First Name": "Nora",
    "Last Name": "Fresh",
    Company: "Acme",
    Domain: "acme.com",
  },
  { Email: "", "First Name": "Ghost", "Last Name": "NoKey", Company: "", Domain: "" },
];

// The parity file: two identities + one reject — the importFast.parity.itest.ts seed shape.
const PARITY_ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "john@acme.com",
    "First Name": "John",
    "Last Name": "Roe",
    Company: "Acme",
    Domain: "acme.com",
  },
  { Email: "", "First Name": "Ghost", "Last Name": "NoKey", Company: "", Domain: "" },
];

/** Workspace-wide viewer (scoped:false = the gate-off short-circuit — visibility itself is T-V1..4's). */
const viewer = () => ({ userId: ownerA, role: "owner" as const, scoped: false });

async function seedWorkspace(
  slug: string,
  tenantId?: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  let tid = tenantId;
  if (!tid) {
    const [t] =
      await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
    tid = (t as { id: string }).id;
  }
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const uid = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tid}, ${uid}, true)
    ON CONFLICT DO NOTHING`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tid}, ${slug}, ${slug}, false, ${uid}) RETURNING id`;
  return { tenantId: tid, workspaceId: (w as { id: string }).id, ownerId: uid };
}

async function contactNames(workspaceId: string): Promise<string[]> {
  const rows = await admin`
    SELECT first_name FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY first_name`;
  return rows.map((r) => (r as { first_name: string }).first_name);
}

/** Create a DRAFT control row exactly as the gate-on draft-create verb does (routes.ts S-I8 branch). */
async function createDraft(
  workspaceId: string,
  opts?: { sourceKey?: string; idempotencyKey?: string },
): Promise<string> {
  const { id } = await dbm.withTenantTx({ tenantId: tenantA, workspaceId }, (tx) =>
    dbm.importJobRepository.createJob(tx, {
      tenantId: tenantA,
      workspaceId,
      createdByUserId: ownerA,
      status: "draft",
      sourceFile: opts?.sourceKey ?? `imports/${crypto.randomUUID()}/source.csv`,
      sourceName: "manual",
      fileSize: 1024,
      idempotencyKey: opts?.idempotencyKey ?? null,
      columnMapping: {},
      sourceFilename: "acme.csv",
      // processing_mode deliberately UNSET — the server routes at COMMIT (08 §1).
    }),
  );
  return id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("import_draft");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsDraft, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ workspaceId: wsOneShot } = await seedWorkspace("acme-oneshot", tenantA));
  ({ workspaceId: wsDraftRun } = await seedWorkspace("acme-draftrun", tenantA));

  // Loaded AFTER DATABASE_URL is bound (the db client is a module singleton).
  core = await import("@leadwolf/core");
  dbm = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-I8 T11 — draft lifecycle at the repo seams (guards drive the routes' 409 matrix)", () => {
  test("draft create → mapping save → preview cache → commit flip → guards close", async () => {
    const jobId = await createDraft(wsDraft);
    const scope = { tenantId: tenantA, workspaceId: wsDraft };

    // Fresh draft: mode unset, mapping empty (commit would 422), excluded from history by default.
    const [row0] = await admin`
      SELECT status, processing_mode, column_mapping FROM import_jobs WHERE id = ${jobId}`;
    expect((row0 as { status: string }).status).toBe("draft");
    expect((row0 as { processing_mode: string | null }).processing_mode).toBeNull();

    // 08 §7 history posture: default list EXCLUDES the draft; drafts:'only' returns it.
    const defaults = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.listJobs(tx, viewer(), {}),
    );
    expect(defaults.some((j) => j.id === jobId)).toBe(false);
    const draftsOnly = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.listJobs(tx, viewer(), { drafts: "only" }),
    );
    expect(draftsOnly.some((j) => j.id === jobId)).toBe(true);

    // Commit-quota census (08 §2.3): an uncommitted draft is NOT a commit.
    const hourAgo = new Date(Date.now() - 3_600_000);
    const preCommitCensus = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.countJobsCreatedSince(tx, wsDraft, hourAgo),
    );
    expect(preCommitCensus).toBe(0);

    // Mapping save (PUT semantics — draft-pinned).
    const saved = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.updateDraftMapping(tx, jobId, {
        columnMapping: MAPPING,
        mergeMode: "create_and_update",
        preservePopulated: false,
      }),
    );
    expect(saved).toBe(true);

    // Preview cache (non-PII summary on the row).
    const cached = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.savePreviewSummary(tx, jobId, { total: 4, valid: 2 }),
    );
    expect(cached).toBe(true);

    // Commit flip — exactly the route's transition (status + routing verdict + replay key).
    await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.updateJobStatus(tx, jobId, {
        status: "queued",
        processingMode: "fast",
        options: { commitIdempotencyKey: "commit-key-1" },
      }),
    );

    // Census now counts the committed job; the list shows it without the drafts opt-in.
    const postCommitCensus = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.countJobsCreatedSince(tx, wsDraft, hourAgo),
    );
    expect(postCommitCensus).toBe(1);
    const postList = await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.listJobs(tx, viewer(), {}),
    );
    expect(postList.some((j) => j.id === jobId)).toBe(true);

    // Every draft-pinned guard closes on the committed row — the routes' 409 matrix drivers.
    const [mapAfter, cacheAfter, deleteAfter] = await dbm.withTenantTx(scope, async (tx) => [
      await dbm.importJobRepository.updateDraftMapping(tx, jobId, { columnMapping: MAPPING }),
      await dbm.importJobRepository.savePreviewSummary(tx, jobId, { total: 0 }),
      await dbm.importJobRepository.deleteDraftJob(tx, jobId),
    ]);
    expect(mapAfter).toBe(false);
    expect(cacheAfter).toBe(false);
    expect(deleteAfter).toBe(false);
    const [still] = await admin`SELECT status FROM import_jobs WHERE id = ${jobId}`;
    expect((still as { status: string }).status).toBe("queued");
  });

  test("idempotency-key collapse: a re-upload with the same key returns the SAME draft", async () => {
    const first = await createDraft(wsDraft, { idempotencyKey: "draft-key-1" });
    const second = await createDraft(wsDraft, { idempotencyKey: "draft-key-1" });
    expect(second).toBe(first);
  });

  test("commit parity with the one-shot: the same rows land the identical end-state (T11 parity leg)", async () => {
    // ONE-SHOT twin: the S-I3 create shape (queued, mode fast at create, mapping at create).
    const oneShot = await dbm.withTenantTx(
      { tenantId: tenantA, workspaceId: wsOneShot },
      (tx) =>
        dbm.importJobRepository.createJob(tx, {
          tenantId: tenantA,
          workspaceId: wsOneShot,
          createdByUserId: ownerA,
          sourceFile: `inline:${crypto.randomUUID()}`,
          sourceName: "manual",
          columnMapping: MAPPING,
          conflictPolicy: "skip",
          processingMode: "fast",
          sourceFilename: "acme.csv",
        }),
    );
    const oneShotResult = await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsOneShot },
      jobId: oneShot.id,
      input: {
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "acme.csv",
        mapping: MAPPING,
        conflictPolicy: "skip",
        rows: PARITY_ROWS,
      },
    });

    // DRAFT twin: upload → mapping → commit flip → the SAME engine, the SAME input shape.
    const draftId = await createDraft(wsDraftRun);
    const scope = { tenantId: tenantA, workspaceId: wsDraftRun };
    await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.updateDraftMapping(tx, draftId, {
        columnMapping: MAPPING,
        mergeMode: "create_only", // conflictPolicy 'skip' maps onto create_only — the S-I6 mapping
        preservePopulated: false,
      }),
    );
    await dbm.withTenantTx(scope, (tx) =>
      dbm.importJobRepository.updateJobStatus(tx, draftId, {
        status: "queued",
        processingMode: "fast",
        options: { commitIdempotencyKey: "commit-key-parity" },
      }),
    );
    const draftResult = await core.runFastImport({
      scope,
      jobId: draftId,
      input: {
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "acme.csv",
        mapping: MAPPING,
        conflictPolicy: "skip",
        strategy: { mergeMode: "create_only", preservePopulated: false },
        rows: PARITY_ROWS,
      },
    });

    // Identical tallies + identical contact end-state — the draft flow adds a stage, never behavior.
    expect(draftResult.created).toBe(oneShotResult.created);
    expect(draftResult.matched).toBe(oneShotResult.matched);
    expect(draftResult.rejected).toBe(oneShotResult.rejected);
    expect(draftResult.total).toBe(oneShotResult.total);
    expect(await contactNames(wsDraftRun)).toEqual(await contactNames(wsOneShot));

    const [jr] = await admin`
      SELECT status, processing_mode FROM import_jobs WHERE id = ${draftId}`;
    expect((jr as { status: string }).status).toBe("partial"); // 1 reject ⇒ the honest terminal
    expect((jr as { processing_mode: string }).processing_mode).toBe("fast");
  });
});

describe("S-I8 T12 (draft half) — the preview projection is non-PII; samples are transient", () => {
  test("full-pass summary: counts, wouldCreate/wouldUpdate, duplicate-in-file, codes — never values", async () => {
    // Seed ONE existing contact so exactly one preview row projects as an update.
    await core.runImport({
      scope: { tenantId: tenantA, workspaceId: wsDraft },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "seed.csv",
      mapping: MAPPING,
      conflictPolicy: "skip",
      rows: [PREVIEW_ROWS[0]!],
    });

    const result = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsDraft }, (tx) =>
      core.buildDraftPreviewSummary(tx, wsDraft, PREVIEW_ROWS, MAPPING),
    );

    expect(result.summary.total).toBe(4);
    expect(result.summary.valid).toBe(2);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.duplicateInFile).toBe(1);
    expect(result.summary.wouldUpdate).toBe(1); // the seeded identity
    expect(result.summary.wouldCreate).toBe(1); // the fresh identity
    // Typed-code histogram + per-column feedback: codes, canonical columns, LINE NUMBERS only.
    expect(result.summary.rejectHistogram.missing_identifier).toBe(1);
    const wholeRow = result.summary.perColumn.find((c) => c.column === "(row)");
    expect(wholeRow?.parseFailures).toBe(1);
    expect(wholeRow?.dominantRejectCode).toBe("missing_identifier");
    expect(wholeRow?.sampleLines).toEqual([3]);

    // NON-PII BY CONSTRUCTION (T12): no row value ever appears in the persistable summary.
    const serialized = JSON.stringify(result.summary);
    for (const value of ["acme.com", "existing@", "new@", "Nora", "Eve", "Ghost", "Acme"]) {
      expect(serialized).not.toContain(value);
    }

    // The TRANSIENT sample is where values legally live (returned to the uploader, never persisted).
    expect(result.sampleRejectedRows.length).toBe(1);
    expect(result.sampleRejectedRows[0]?.code).toBe("missing_identifier");
    expect(result.sampleRejectedRows[0]?.row).toBe(3);
  });

  test("determinism: the same file + mapping + dataset projects identically", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsDraft };
    const a = await dbm.withTenantTx(scope, (tx) =>
      core.buildDraftPreviewSummary(tx, wsDraft, PREVIEW_ROWS, MAPPING),
    );
    const b = await dbm.withTenantTx(scope, (tx) =>
      core.buildDraftPreviewSummary(tx, wsDraft, PREVIEW_ROWS, MAPPING),
    );
    expect(a.summary).toEqual(b.summary);
  });
});

describe("S-I8 T12 (reaper half) — census + draft-pinned delete", () => {
  test("only TTL-expired drafts enumerate; committed jobs never reap", async () => {
    const expired = await createDraft(wsDraft, {
      sourceKey: `imports/${crypto.randomUUID()}/source.csv`,
    });
    const fresh = await createDraft(wsDraft);
    // Backdate ONLY the expired one past the 48 h default.
    await admin`
      UPDATE import_jobs SET created_at = now() - interval '3 days' WHERE id = ${expired}`;

    const cutoff = new Date(Date.now() - 48 * 3_600_000);
    const candidates = await dbm.importJobRepository.listReapableDrafts(cutoff, 100);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(expired);
    expect(ids).not.toContain(fresh);
    // The census carries the object key for the post-delete object cleanup.
    expect(candidates.find((c) => c.id === expired)?.sourceFile).toMatch(/^imports\//);

    // Draft-pinned hard delete: the expired draft goes; a committed row NEVER does (guard proven in
    // the lifecycle test above). Row-first ordering is the sweep's (importReaperSweep job 4).
    const deleted = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsDraft }, (tx) =>
      dbm.importJobRepository.deleteDraftJob(tx, expired),
    );
    expect(deleted).toBe(true);
    const gone = await admin`SELECT 1 FROM import_jobs WHERE id = ${expired}`;
    expect(gone.length).toBe(0);
    // Idempotent re-reap: a second delete is a clean no-op false.
    const again = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsDraft }, (tx) =>
      dbm.importJobRepository.deleteDraftJob(tx, expired),
    );
    expect(again).toBe(false);
  });
});
