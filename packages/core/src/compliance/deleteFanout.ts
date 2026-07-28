// deleteFanout.ts — the DSAR delete (08 §4.2, H6): resolve every per-workspace copy of the subject by
// blind index, tombstone each (PII nulled), purge dependents (source_imports / contact_reveals /
// consent_records), add a GLOBAL suppression row, write a per-copy audit + the dsar.delete proof, then a
// VERIFICATION SCAN gates `completed` — idempotent and re-runnable. Runs under the privileged
// leadwolf_admin role (the one sanctioned cross-workspace path); the request must be verified first.

import {
  crmRecordLinkRepository,
  dsarFanoutRepository,
  dsarRequestRepository,
  withPrivilegedTx,
} from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { blindIndex } from "../import/blindIndex.ts";
import { writeAudit } from "./writeAudit.ts";

export interface DeleteFanoutResult {
  requestId: string;
  copiesErased: number;
  verification: { liveCopies: number; piiOnTombstones: number; dependents: number };
  completed: boolean;
}

/**
 * One outbound CRM erase to schedule (crm-sync 00 §7.6). Ids + provider only — never the subject's data.
 */
export interface CrmEraseTarget {
  linkId: string;
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  crmObjectType: string;
  crmRecordId: string;
  tpEntityType: string;
}

/**
 * The seam the composition root uses to enqueue outbound CRM erases.
 *
 * Injected rather than imported so core stays BullMQ-free. OPTIONAL, and its absence is safe in exactly one
 * direction: without it the erases are never scheduled, the crm_record_links rows survive, the residual scan
 * keeps counting them and the request stays `processing`. A DSAR that cannot complete is a visible problem;
 * one that completes while the subject is still in a customer's CRM is a false erasure claim. Failing in the
 * loud direction is the point.
 */
export type EnqueueCrmErase = (targets: CrmEraseTarget[]) => Promise<void>;

export async function deleteFanout(
  requestId: string,
  subjectEmail: string,
  enqueueCrmErase?: EnqueueCrmErase,
): Promise<DeleteFanoutResult> {
  const subjectIndex = blindIndex(subjectEmail.trim().toLowerCase());

  return withPrivilegedTx<DeleteFanoutResult & { eraseTargets: CrmEraseTarget[] }>(async (tx) => {
    const request = await dsarRequestRepository.getById(tx, requestId);
    if (!request) throw new NotFoundError("DSAR request not found.");
    await dsarRequestRepository.setStatus(tx, requestId, "processing");

    // 1) Find-everywhere: every copy across every tenant/workspace (live ones still carry the index).
    const copies = await dsarFanoutRepository.findCopies(tx, subjectIndex);
    const liveCopies = copies.filter((c) => c.deletedAt === null);

    // 2) Tombstone each copy + purge dependents; one audit row per copy (the per-copy proof).
    for (const copy of liveCopies) {
      await dsarFanoutRepository.tombstone(tx, copy.contactId);
      await writeAudit(tx, {
        tenantId: copy.tenantId,
        workspaceId: copy.workspaceId,
        actorUserId: null, // system: the DSAR job
        action: "dsar.delete",
        entityType: "contact",
        entityId: copy.contactId,
        metadata: { requestId },
      });
    }
    await dsarFanoutRepository.purgeDependents(
      tx,
      liveCopies.map((c) => c.contactId),
    );

    // 2b) The OUTBOUND half (crm-sync §7.6): a subject who exists in a customer's CRM is not erased until
    // the CRM says so. crm_record_links is deliberately NOT purged above — the row carries the record id the
    // erase job needs, and it is what the verification scan below counts, so it survives until the provider
    // confirms. Collected here, scheduled after the transaction commits.
    const eraseTargets = await crmRecordLinkRepository.listEraseTargets(
      tx,
      liveCopies.map((c) => c.contactId),
    );

    // 3) Global suppression so no source, sync, or re-enrichment ever re-monetizes the subject.
    if (liveCopies.length > 0) {
      await dsarFanoutRepository.addGlobalSuppression(tx, subjectIndex, `dsar:${requestId}`);
    }

    // 4) Verification scan — `completed` ONLY when zero residual PII remains (08 §4.2 step 6).
    const verification = await dsarFanoutRepository.scanResiduals(
      tx,
      subjectIndex,
      liveCopies.map((c) => c.contactId),
    );
    const clean =
      verification.liveCopies === 0 &&
      verification.piiOnTombstones === 0 &&
      verification.dependents === 0;
    await dsarRequestRepository.setStatus(tx, requestId, clean ? "completed" : "processing", {
      scopeReport: { erased: liveCopies.length, verification },
      ...(clean ? { completedAt: new Date() } : {}),
    });

    return {
      requestId,
      copiesErased: liveCopies.length,
      verification,
      completed: clean,
      eraseTargets,
    };
  }).then(async (result) => {
    // Scheduled AFTER the privileged transaction commits, so an erase job can never reference a link row
    // that rolled back. Best-effort by design: a failed enqueue leaves the link in place, the residual scan
    // keeps counting it, and re-running deleteFanout (it is idempotent and re-runnable) schedules it again.
    if (enqueueCrmErase && result.eraseTargets.length > 0) {
      await enqueueCrmErase(result.eraseTargets);
    }
    const { eraseTargets: _dropped, ...rest } = result;
    return rest;
  });
}
