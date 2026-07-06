// importCopyRouting.itest.ts — S-I9's test gate (import-and-data-model-redesign 15 §T-P2 seq 40): the T7
// COPY HALF at the repo/core seams, the house itest posture (importDraft.itest.ts precedent — routes are
// transport; the seams they compose are what integration proves):
//
//   • the 0057 P2 audit-CHECK train: `import.av_infected` + `import.draft_reaped` COMMIT through the real
//     writeAudit/RLS path (their writers no longer fail the DB CHECK — the doc-16 deferrals are closed),
//     and the CHECK stays CLOSED (an unknown action is rejected by the DB, not just the type layer);
//   • submitCopyImport — the ONE store-then-enqueue copy submission BOTH engaged surfaces delegate to
//     (the unified one-shot POST + the /imports/bulk delegate): over-threshold + engaged ⇒ a
//     `processing_mode='copy'` control row + the stored source object + exactly ONE drive enqueued
//     (idempotency-first: a replayed Idempotency-Key returns the same job and re-streams/re-enqueues
//     NOTHING); a storage failure marks the job failed and enqueues nothing;
//   • the not-engaged refusal half + the full threshold×gates matrix is decideImportRouting's colocated
//     unit (packages/core routing.test.ts); the route-level E2E (≥100k-row canary + T-X2 outcome parity)
//     rides CI per 15 seq 40.
//
// Real Postgres via Testcontainers (or ITEST_DATABASE_URL); no Redis (the drive producer is injected — the
// queue transport is proven by imports.queue.itest.ts). Run explicitly, own process:
//   bun test packages/db/test/importCopyRouting.itest.ts

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
let wsA = "";
let ownerA = "";

const MAPPING = { email: "Email", firstName: "First Name" };

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tid = (t as { id: string }).id;
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

/** In-memory FileStore + drive collector — the submitCopyImport injection seam (no Redis, no disk). */
function memHarness() {
  const objects = new Map<string, Uint8Array>();
  const drives: string[] = [];
  const fileStore = {
    async putObject(
      key: string,
      body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array,
    ): Promise<void> {
      if (body instanceof Uint8Array) {
        objects.set(key, body);
        return;
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      objects.set(key, out);
    },
    async getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>> {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`absent object: ${key}`);
      return (async function* () {
        yield bytes;
      })();
    },
    async putArtifact(key: string, bytes: Uint8Array): Promise<void> {
      objects.set(key, bytes);
    },
    async getSignedDownloadUrl(key: string): Promise<string> {
      return `mem://${key}`;
    },
    async deleteObject(key: string): Promise<void> {
      objects.delete(key);
    },
    async deletePrefix(prefix: string): Promise<void> {
      for (const k of objects.keys()) if (k.startsWith(prefix)) objects.delete(k);
    },
  };
  return {
    objects,
    drives,
    fileStore,
    enqueueDrive: async (jobId: string) => {
      drives.push(jobId);
    },
  };
}

beforeAll(async () => {
  dbHandle = await startItestDb("import_copy_routing");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("copyco"));

  // Loaded AFTER DATABASE_URL is bound (the db client is a module singleton).
  core = await import("@leadwolf/core");
  dbm = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await dbHandle?.stop();
});

describe("0057 — the P2 audit-action CHECK train (ruling M1)", () => {
  test("import.av_infected + import.draft_reaped commit through the real writeAudit path", async () => {
    await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
      await core.writeAudit(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        actorUserId: null, // system actor — the drive/reaper posture
        action: "import.av_infected",
        entityType: "import_job",
        entityId: crypto.randomUUID(),
        metadata: { signature: "Eicar-Signature" },
      });
      await core.writeAudit(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        actorUserId: null,
        action: "import.draft_reaped",
        entityType: "import_job",
        entityId: crypto.randomUUID(),
        metadata: { ageHours: 49 },
      });
    });
    const rows = await admin`
      SELECT action FROM audit_log
      WHERE tenant_id = ${tenantA} AND action IN ('import.av_infected','import.draft_reaped')
      ORDER BY action`;
    expect(rows.map((r) => (r as { action: string }).action)).toEqual([
      "import.av_infected",
      "import.draft_reaped",
    ]);
  });

  test("the CHECK stays CLOSED — an action outside the enum is rejected by the DB", async () => {
    await expect(
      admin`
        INSERT INTO audit_log (tenant_id, workspace_id, action, entity_type)
        VALUES (${tenantA}, ${wsA}, 'import.not_a_real_action', 'import_job')`,
    ).rejects.toThrow(/audit_log_action_enum/);
  });
});

describe("S-I9 — submitCopyImport, the one store-then-enqueue copy submission (T7 copy half, seam level)", () => {
  test("over-threshold + engaged ⇒ processing_mode='copy' row + stored object + exactly ONE drive", async () => {
    const h = memHarness();
    const bytes = new TextEncoder().encode("Email,First Name\na@x.test,Ann\n");

    const { jobId, created } = await core.submitCopyImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      createdByUserId: ownerA,
      sourceName: "manual",
      fileName: "Big Export (2026).csv",
      fileSize: bytes.byteLength,
      body: () => bytes,
      avScanStatus: "skipped",
      idempotencyKey: "copy-submit-key-1",
      columnMapping: MAPPING,
      conflictPolicy: "skip",
      targetListId: null,
      mergeMode: "create_and_update",
      preservePopulated: false,
      fileStore: h.fileStore,
      enqueueDrive: h.enqueueDrive,
    });

    expect(created).toBe(true);
    expect(h.drives).toEqual([jobId]);

    const [row] = await admin`
      SELECT status, processing_mode, source_file, source_filename, file_size, merge_mode,
             preserve_populated, av_scan_status
      FROM import_jobs WHERE id = ${jobId}`;
    const job = row as {
      status: string;
      processing_mode: string;
      source_file: string;
      source_filename: string;
      file_size: number;
      merge_mode: string;
      preserve_populated: boolean;
      av_scan_status: string;
    };
    // The trio marked identically to the unified surface: the server's verdict + the honest display name.
    expect(job.status).toBe("queued");
    expect(job.processing_mode).toBe("copy");
    expect(job.source_filename).toBe("Big Export (2026).csv");
    // Sanitized key idiom — the untrusted filename never rides the path (alnum ext only).
    expect(job.source_file).toMatch(/^imports\/[0-9a-f-]{36}\/source\.csv$/);
    expect(job.merge_mode).toBe("create_and_update");
    expect(job.preserve_populated).toBe(false);
    expect(job.av_scan_status).toBe("skipped");
    // The DRIVE's source of truth: the object is stored under the row's exact key, byte-for-byte.
    expect(h.objects.get(job.source_file)).toEqual(bytes);
  });

  test("Idempotency-Key replay collapses: same jobId, nothing re-stored, NO second drive", async () => {
    const h = memHarness();
    const bytes = new TextEncoder().encode("Email\nb@x.test\n");
    const args = {
      scope: { tenantId: tenantA, workspaceId: wsA },
      createdByUserId: ownerA,
      sourceName: "manual" as const,
      fileName: "replay.csv",
      fileSize: bytes.byteLength,
      body: () => bytes,
      avScanStatus: "skipped" as const,
      idempotencyKey: "copy-submit-key-replay",
      columnMapping: MAPPING,
      conflictPolicy: "skip" as const,
      targetListId: null,
      fileStore: h.fileStore,
      enqueueDrive: h.enqueueDrive,
    };
    const first = await core.submitCopyImport(args);
    const second = await core.submitCopyImport(args);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(h.drives).toEqual([first.jobId]); // exactly one drive, ever
    expect(h.objects.size).toBe(1); // the replay streamed nothing (a second key would exist otherwise)
  });

  test("storage failure ⇒ the job is marked failed and NO drive is enqueued", async () => {
    const h = memHarness();
    const failingStore = {
      ...h.fileStore,
      putObject: async () => {
        throw new Error("store down");
      },
    };
    await expect(
      core.submitCopyImport({
        scope: { tenantId: tenantA, workspaceId: wsA },
        createdByUserId: ownerA,
        sourceName: "manual",
        fileName: "doomed.csv",
        fileSize: 4,
        body: () => new Uint8Array([1, 2, 3, 4]),
        avScanStatus: "skipped",
        idempotencyKey: "copy-submit-key-doomed",
        columnMapping: MAPPING,
        conflictPolicy: "skip",
        targetListId: null,
        fileStore: failingStore,
        enqueueDrive: h.enqueueDrive,
      }),
    ).rejects.toThrow("store down");
    expect(h.drives).toEqual([]);
    const [row] = await admin`
      SELECT status, failed_reason FROM import_jobs
      WHERE workspace_id = ${wsA} AND source_filename = ${"doomed.csv"}`;
    expect((row as { status: string }).status).toBe("failed");
    expect((row as { failed_reason: string }).failed_reason).toBe(
      "Failed to store the uploaded file.",
    );
  });
});
