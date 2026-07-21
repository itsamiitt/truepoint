// runBulkReveal.ts — the worker side of the async bulk-reveal job (Phase 3). `runBulkRevealDrive` plans the
// row bands and enqueues one chunk each (resume-safe: a chunk only touches still-`queued` rows).
// `bulkProcessRevealChunk` reveals its band THROUGH the gated revealContact in `lease` settle-mode (the job's
// lease already reserved the credits — no per-row counter lock), records each contact's outcome + cost, and
// bumps the job counters atomically. When the last queued row is drained it writes the revealed CSV and calls
// finalizeAndRelease (status-pinned → exactly-once), returning the unspent lease remainder to the tenant.

import { type TenantScope, creditRepository, revealJobRepository } from "@leadwolf/db";
import {
  EVENT_CREDITS_CHANGED,
  EVENT_REVEAL_JOB_COMPLETED,
  EVENT_REVEAL_JOB_PROGRESS,
  type RevealType,
  SuppressedError,
} from "@leadwolf/types";
import type { EmailVerifierPort } from "../../data-health/emailVerifier.ts";
import type { PhoneVerifierPort } from "../../data-health/phoneVerifier.ts";
import type { FileStore } from "../../storage/fileStore.ts";
import { getRevealedContactsBatch } from "../getRevealedContact.ts";
import { revealContact } from "../revealContact.ts";
import { emitRevealEvent, realtimeEnabled } from "./emitRevealEvent.ts";

type WsScope = TenantScope & { workspaceId: string };

/** Contacts per chunk. Reveals are per-contact network verifies, so bands are smaller than bulk-enrich's 2000. */
export const REVEAL_CHUNK_ROWS = 500;

/** Enqueue one `chunk` job (injected so core never imports BullMQ). The drive passes its own jobId + scope. */
export type EnqueueRevealChunk = (
  jobId: string,
  scope: WsScope,
  band: { rowStart: number; rowEnd: number },
) => Promise<void>;

export interface RunBulkRevealDriveInput {
  scope: WsScope;
  jobId: string;
  enqueueChunk: EnqueueRevealChunk;
}

/** Plan + enqueue the chunk bands (or finalize immediately for a zero-row job). Runs only for `running` jobs. */
export async function runBulkRevealDrive(
  input: RunBulkRevealDriveInput,
): Promise<{ skipped?: boolean; bands: number }> {
  const job = await revealJobRepository.getJobSystem(input.scope, input.jobId);
  if (!job || job.status !== "running") return { skipped: true, bands: 0 };
  const total = job.totalContacts;
  if (total === 0) {
    await revealJobRepository.finalizeAndRelease(
      input.scope,
      input.jobId,
      null,
      job.createdByUserId,
    );
    return { bands: 0 };
  }
  let bands = 0;
  for (let start = 0; start < total; start += REVEAL_CHUNK_ROWS) {
    await input.enqueueChunk(input.jobId, input.scope, {
      rowStart: start,
      rowEnd: Math.min(start + REVEAL_CHUNK_ROWS, total),
    });
    bands += 1;
  }
  return { bands };
}

export interface BulkProcessRevealChunkInput {
  scope: WsScope;
  jobId: string;
  rowStart: number;
  rowEnd: number;
  verifier?: EmailVerifierPort;
  phoneVerifier?: PhoneVerifierPort;
  fileStore: FileStore;
}

/** Reveal a band's queued rows; finalize + release when this band drains the last queued row. */
export async function bulkProcessRevealChunk(
  input: BulkProcessRevealChunkInput,
): Promise<{ processed: number; finalized: boolean }> {
  const job = await revealJobRepository.getJobSystem(input.scope, input.jobId);
  // Stop the moment the job is no longer running (paused / cancelled / already completed).
  if (!job || job.status !== "running") return { processed: 0, finalized: false };
  const revealType = job.revealType as RevealType;
  const userId = job.createdByUserId ?? "";

  const rows = await revealJobRepository.listBandQueuedRows(
    input.scope,
    input.jobId,
    input.rowStart,
    input.rowEnd,
  );

  const tally = { processed: 0, revealed: 0, alreadyOwned: 0, suppressed: 0, failed: 0, spent: 0 };
  for (const row of rows) {
    // Re-check status periodically so a cancel/pause stops the band promptly (not just at the next chunk).
    // Remaining rows stay `queued` → a resume re-processes them; a cancel releases the lease.
    if (tally.processed > 0 && tally.processed % 25 === 0) {
      const live = await revealJobRepository.getJobSystem(input.scope, input.jobId);
      if (!live || live.status !== "running") break;
    }
    let outcome = "error";
    let charged = 0;
    if (row.contactId) {
      try {
        const res = await revealContact({
          scope: input.scope,
          userId,
          contactId: row.contactId,
          revealType,
          verifier: input.verifier,
          phoneVerifier: input.phoneVerifier,
          settleMode: "lease",
        });
        charged = res.creditsCharged;
        if (res.alreadyOwned) {
          outcome = "already_owned";
          tally.alreadyOwned += 1;
        } else {
          outcome = "revealed";
          tally.revealed += 1;
        }
        tally.spent += charged;
      } catch (err) {
        if (err instanceof SuppressedError) {
          outcome = "suppressed";
          tally.suppressed += 1;
        } else {
          outcome = "error";
          tally.failed += 1;
        }
      }
    } else {
      tally.failed += 1;
    }
    await revealJobRepository.setRowOutcome(input.scope, row.id, outcome, charged);
    tally.processed += 1;
  }

  await revealJobRepository.updateJobProgress(input.scope, input.jobId, {
    processedContacts: tally.processed,
    revealedContacts: tally.revealed,
    alreadyOwnedContacts: tally.alreadyOwned,
    suppressedContacts: tally.suppressed,
    failedContacts: tally.failed,
    creditSpent: tally.spent,
  });

  // Realtime (best-effort, coalesced): stream the cumulative progress for the live bar. Dark until
  // REALTIME_SSE_ENABLED (the getJob is skipped entirely while off).
  if (realtimeEnabled()) {
    const after = await revealJobRepository.getJobSystem(input.scope, input.jobId);
    if (after) {
      await emitRevealEvent(input.scope, EVENT_REVEAL_JOB_PROGRESS, {
        jobId: input.jobId,
        status: after.status,
        processedContacts: after.processedContacts,
        totalContacts: after.totalContacts,
        revealedContacts: after.revealedContacts,
      });
    }
  }

  // Finalize iff this band drained the last queued row. finalizeAndRelease is status-pinned → exactly-once, so a
  // concurrent sibling chunk that also sees 0 remaining just re-writes the same CSV and loses the release race.
  const remaining = await revealJobRepository.countQueuedRows(input.scope, input.jobId);
  if (remaining > 0) return { processed: tally.processed, finalized: false };

  const resultKey = await buildRevealedCsv(input.scope, input.jobId, input.fileStore);
  const finalized = await revealJobRepository.finalizeAndRelease(
    input.scope,
    input.jobId,
    resultKey,
    userId || null,
  );

  // Realtime (best-effort): on the finalizing chunk, emit the completion + the released-balance change.
  if (finalized && realtimeEnabled()) {
    const done = await revealJobRepository.getJobSystem(input.scope, input.jobId);
    if (done) {
      await emitRevealEvent(input.scope, EVENT_REVEAL_JOB_COMPLETED, {
        jobId: input.jobId,
        status: done.status,
        processedContacts: done.processedContacts,
        totalContacts: done.totalContacts,
        revealedContacts: done.revealedContacts,
      });
    }
    await emitRevealEvent(input.scope, EVENT_CREDITS_CHANGED, {
      balanceAfter: await creditRepository.getBalance(input.scope),
    });
  }

  return { processed: tally.processed, finalized };
}

/** RFC-4180 CSV (always-quoted, CRLF) over the given columns. */
function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const cell = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = columns.map(cell).join(",");
  const lines = rows.map((r) => columns.map((col) => cell(r[col])).join(","));
  return [header, ...lines].join("\r\n");
}

const REVEALED_CSV_COLUMNS = ["id", "email", "phone", "emailStatus", "linkedinUrl"] as const;

/** Build the revealed CSV from the already-owned (no-charge) reveal data for this job's revealed contacts. */
async function buildRevealedCsv(
  scope: WsScope,
  jobId: string,
  fileStore: FileStore,
): Promise<string | null> {
  const ids = await revealJobRepository.listRevealedContactIds(scope, jobId);
  if (ids.length === 0) return null;
  const revealed = await getRevealedContactsBatch(scope, ids);
  const rows = revealed.map((r) => ({
    id: r.contactId,
    email: r.email ?? "",
    phone: r.phone ?? "",
    emailStatus: r.emailStatus ?? "",
    linkedinUrl: r.linkedinUrl ?? "",
  }));
  const csv = toCsv(rows, REVEALED_CSV_COLUMNS);
  const key = `exports/${scope.workspaceId}/reveal-${jobId}.csv`;
  await fileStore.putArtifact(key, new TextEncoder().encode(csv));
  return key;
}
