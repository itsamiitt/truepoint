// processors — the per-stage job handlers that turn the Forge queues into a RUNNING pipeline. Each reads its
// input, invokes the pure @leadwolf/forge-core stage over REAL adapters (db repos under withForgeTx, S3 blob,
// the Anthropic port), writes the result, and enqueues the next stage. The SYNC stage writes master_*
// IN-PROCESS (withErTx + forgeSyncRepository) — no HTTP push (the nested-repo simplification, ADR-0047).
// Handlers are idempotent (keyed writes), so a retry or redelivery converges.
import {
  type SyncApplyItem,
  countExtractionCandidates,
  drainSyncOutbox,
  forgeSyncRepository,
  getRawCaptureById,
  getRawCaptureForParse,
  getVerifyInputs,
  insertApprovalRequest,
  insertExtractionCandidates,
  insertExtractionRun,
  insertQuarantine,
  insertReviewTask,
  markSyncOutboxDispatched,
  markSyncStateSynced,
  upsertMasterIdMap,
  upsertParsedRecord,
  withErTx,
  withForgeTx,
} from "@leadwolf/db";
import type { BlobFetcher, ExtractionPort, ParserRegistry } from "@leadwolf/forge-core";
import {
  VERIFY_THRESHOLD,
  assembleVerifiedCandidate,
  computePriority,
  inMemoryBudgetStore,
  runExtraction,
  runParse,
  shapeFingerprint,
} from "@leadwolf/forge-core";
import type { Job, Queue } from "bullmq";

/** The fields the AI extraction stage targets from an intercepted profile (09 §target fields). */
const TARGET_FIELDS = ["full_name", "headline", "current_title", "current_company", "location"];
const AI_BUDGET_LIMIT = 1000;
/** The four-eyes MAKER for a capturer-less (system-initiated) capture — the nil uuid, distinct from every real
 *  user, so a human approver always differs from it and four-eyes still requires a genuine second party. */
const FORGE_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export interface ProcessorDeps {
  blob: BlobFetcher;
  registry: ParserRegistry;
  extractPort: ExtractionPort;
  queues: { aiExtract: Queue; resolve: Queue; verify: Queue };
  leader: <T>(fn: () => Promise<T>) => Promise<T | null>;
}

async function readPayload(
  blob: BlobFetcher,
  inline: string | null,
  ref: string | null,
): Promise<string> {
  if (inline !== null) return inline;
  return ref ? blob.fetch(ref) : "{}";
}

/** parse: raw_captures → parsed_records (one leadwolf_forge tx), then enqueue ai-extract. */
export function makeParseProcessor(deps: ProcessorDeps) {
  return async (job: Job<{ contentHash: string }>): Promise<void> => {
    const rawCaptureId = await withForgeTx(async (tx) => {
      const row = await getRawCaptureForParse(tx, job.data.contentHash);
      if (!row) return null;
      const payload = await readPayload(deps.blob, row.payloadInline, row.payloadRef);
      let fingerprint: string;
      try {
        fingerprint = shapeFingerprint(JSON.parse(payload));
      } catch {
        fingerprint = shapeFingerprint({});
      }
      await runParse(
        {
          registry: deps.registry,
          // map @leadwolf/forge-core's ParsedRecordUpsert (status/provenance/errors) → the db row shape.
          store: {
            upsert: (r) =>
              upsertParsedRecord(tx, {
                rawCaptureId: r.rawCaptureId,
                parserVersionId: r.parserVersionId,
                parseStatus: r.status,
                fields: r.fields,
                fieldProvenance: r.provenance,
                parseErrors: r.errors,
                blockKey: r.blockKey,
                emailBlindIndex: r.emailBlindIndex,
                phoneBlindIndex: r.phoneBlindIndex,
              }),
          },
          blob: deps.blob,
          quarantine: {
            // Persist the drift (P-01.8) — same leadwolf_forge tx as the parse, so a quarantined capture and the
            // absence of a parsed_record commit atomically. Was a bare console.warn; drifted captures were lost.
            record: async (id, route, reason) => {
              await insertQuarantine(tx, { rawCaptureId: id, route, reason });
              console.warn(`[forge-parse] quarantine ${id} ${route}: ${reason}`);
            },
          },
        },
        {
          id: row.id,
          source: row.source,
          endpoint: row.endpoint,
          schemaVersion: row.schemaVersion,
          fingerprint,
          payloadInline: row.payloadInline,
          payloadRef: row.payloadRef,
          capturedAt: row.ingestedAt.toISOString(),
        },
      );
      return row.id;
    });
    if (rawCaptureId) await deps.queues.aiExtract.add("forge-ai-extract", { rawCaptureId });
  };
}

/** ai-extract: parsed residue → grounded candidate fields (REAL Anthropic), then enqueue resolve. */
export function makeExtractProcessor(deps: ProcessorDeps) {
  const budgetStore = inMemoryBudgetStore();
  return async (job: Job<{ rawCaptureId: string }>): Promise<void> => {
    const ctx = await withForgeTx(async (tx) => {
      const capture = await getRawCaptureById(tx, job.data.rawCaptureId);
      if (!capture) return null;
      const residue = await readPayload(deps.blob, capture.payloadInline, capture.payloadRef);
      return { tenantId: capture.targetTenantId, residue, schemaVersion: capture.schemaVersion };
    });
    if (!ctx) return;
    // idempotency (P-01.16): a redelivered/retried job must NOT re-bill Anthropic or duplicate metering. If this
    // capture was already extracted (candidates persisted), skip the paid call and just advance to resolve.
    const alreadyExtracted = await withForgeTx((tx) =>
      countExtractionCandidates(tx, job.data.rawCaptureId),
    );
    if (alreadyExtracted > 0) {
      await deps.queues.resolve.add("forge-resolve", { rawCaptureId: job.data.rawCaptureId });
      return;
    }
    const extraction = await runExtraction(
      {
        port: deps.extractPort,
        budgetStore,
        budgetLimit: AI_BUDGET_LIMIT,
        meter: (r) => withForgeTx((tx) => insertExtractionRun(tx, r)),
      },
      {
        jobId: job.data.rawCaptureId,
        tenantId: ctx.tenantId,
        residue: ctx.residue,
        targetFields: TARGET_FIELDS,
        schemaVersion: ctx.schemaVersion,
      },
    );
    // Persist the extracted candidates (P-01.2) — previously discarded, so promotion had no real data to promote.
    if (extraction.fields.length > 0) {
      await withForgeTx((tx) =>
        insertExtractionCandidates(
          tx,
          extraction.fields.map((f) => ({
            rawCaptureId: job.data.rawCaptureId,
            path: f.path,
            value: f.value,
            confidence: f.confidence,
            band: f.band,
            grounded: f.grounded,
            extractSchemaVersion: ctx.schemaVersion,
          })),
        ),
      );
    }
    await deps.queues.resolve.add("forge-resolve", { rawCaptureId: job.data.rawCaptureId });
  };
}

/** resolve: per-record hand-off to verify. Full cross-dataset ER clustering is the maintenance batch (er.ts). */
export function makeResolveProcessor(deps: ProcessorDeps) {
  return async (job: Job<{ rawCaptureId: string }>): Promise<void> => {
    await deps.queues.verify.add("forge-verify", { rawCaptureId: job.data.rawCaptureId });
  };
}

/** verify: assemble a SERVER-authoritative gold candidate from the silver outputs, persist it as a pending
 *  approval_request (four-eyes MAKER = the capturer, never the client), and enqueue a HUMAN review task LINKED to
 *  it (P-01.10). The worker NEVER self-approves — promotion is API-driven via /v1/review/approve, which loads the
 *  maker + candidate from the approval_request (not its request body). Idempotent: a redelivered verify converges
 *  on the approval_request's (op_class, content_hash) partial unique, so the review task dedups too. */
export function makeVerifyProcessor(_deps: ProcessorDeps) {
  return async (job: Job<{ rawCaptureId: string }>): Promise<void> => {
    await withForgeTx(async (tx) => {
      const inputs = await getVerifyInputs(tx, job.data.rawCaptureId);
      if (!inputs) return; // no parsed record (quarantined / not yet parsed) → nothing to verify

      const candidate = assembleVerifiedCandidate({
        entityKind: inputs.entityKind,
        parsedFields: inputs.parsedFields,
        extractions: inputs.extractions,
        channels: {
          emailBlindIndex: inputs.emailBlindIndex ?? undefined,
          phoneBlindIndex: inputs.phoneBlindIndex ?? undefined,
        },
      });

      const approvalRequestId = await insertApprovalRequest(tx, {
        opClass: "verify.promote",
        requestedByUserId: inputs.capturedByUserId ?? FORGE_SYSTEM_USER_ID,
        subjectRef: candidate.contentHash,
        payload: candidate,
      });

      await insertReviewTask(tx, {
        // Below-threshold candidates still need a human; the type/priority just rank the queue (uncertainty first).
        taskType: candidate.confidence >= VERIFY_THRESHOLD ? "manual" : "ai_low_confidence",
        subjectRef: approvalRequestId, // the review task points at the approval_request (P-01.10)
        confidence: candidate.confidence,
        priority: computePriority({
          confidence: candidate.confidence,
          value: 0.5,
          freshness: 1,
          risk: 0.5,
        }),
      });
    });
  };
}

/** sync: drain the outbox and apply to master_* IN-PROCESS (withErTx + forgeSyncRepository) — no HTTP. */
export function makeSyncProcessor(_deps: ProcessorDeps) {
  return async (): Promise<void> => {
    const rows = await withForgeTx((tx) => drainSyncOutbox(tx, 50));
    for (const row of rows) {
      const result = await withErTx((tx) =>
        forgeSyncRepository.applyItem(tx, {
          eventId: row.id,
          eventType: row.eventType,
          version: row.version,
          // the forge outbox stores a hex content_hash; applyItem decodes base64 → the sha256 bytes.
          contentHash: Buffer.from(row.contentHash, "hex").toString("base64"),
          // TODO: the promotion must populate the full resolver match keys (linkedinPublicId/registrableDomain)
          // into sync_outbox.payload for a complete in-process mint; today it carries the blind indexes only.
          payload: row.payload as SyncApplyItem["payload"],
        }),
      );
      // Record the forge<->master crosswalk + advance the verified record's sync_state (P-01.20). Skip on a
      // duplicate (a re-drain of an already-applied event) so a null masterId never clobbers a good one; the
      // narrow crash window between apply and this write is recovered by the maintenance reconciliation sweep.
      if (result.outcome !== "duplicate") {
        const entityKind = row.aggregateKind.replace(/^verified_/, "");
        await withForgeTx(async (tx) => {
          await upsertMasterIdMap(tx, {
            forgeId: row.forgeId,
            masterId: result.masterId,
            entityKind,
            contentHash: row.contentHash,
            syncedVersion: row.version,
          });
          await markSyncStateSynced(tx, row.forgeId);
        });
      }
    }
    if (rows.length > 0)
      await withForgeTx((tx) =>
        markSyncOutboxDispatched(
          tx,
          rows.map((r) => r.id),
        ),
      );
  };
}

/** maintenance: leader-elected reconciliation tick. The fingerprint-diff (reconcile) is a documented follow-up. */
export function makeMaintenanceProcessor(deps: ProcessorDeps) {
  return async (): Promise<void> => {
    await deps.leader(async () => {
      // TODO: fingerprint-diff verified_records ↔ master_id_map + idempotent replay. reconcile() lived in
      // @forge/sync (dropped in the nest); re-home into forge-core if the drift monitor is needed.
      console.info("[forge-maintenance] leader tick");
    });
  };
}
