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
import { writeAudit } from "./writeAudit.ts";

export interface DeleteFanoutResult {
  requestId: string;
  copiesErased: number;
  /** Golden (Layer-0) nodes suppressed. Reported separately: erasing the overlay and erasing the shared graph
   *  are different acts with different consequences, and collapsing them hides which one actually happened. */
  masterPersonsSuppressed: number;
  verification: {
    liveCopies: number;
    piiOnTombstones: number;
    dependents: number;
    masterResiduals: number;
  };
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

/**
 * Erase a subject everywhere.
 *
 * Takes ONLY the request id. The subject's blind index is read from the row that intake already stored, so
 * the plaintext email never enters the job payload, the BullMQ job log or a dead-letter record — a pipeline
 * that leaks the address into Redis while erasing it from Postgres is the wrong shape however well the
 * erasure itself works. It also removes the possibility of a caller passing an email that does not match the
 * request, which would have erased the wrong person under a real request's id.
 */
export async function deleteFanout(
  requestId: string,
  enqueueCrmErase?: EnqueueCrmErase,
): Promise<DeleteFanoutResult> {
  return withPrivilegedTx<DeleteFanoutResult & { eraseTargets: CrmEraseTarget[] }>(async (tx) => {
    const request = await dsarRequestRepository.getById(tx, requestId);
    if (!request) throw new NotFoundError("DSAR request not found.");
    const subjectIndex = request.subjectEmailBlindIndex;
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
    //
    // Unconditional, unlike the overlay steps above. A subject with zero live copies today can still exist in
    // the golden graph, and will certainly exist in some future import — the deny list is what makes the
    // erasure hold going forward, so gating it on "did we find anything to erase right now" would make an
    // erasure request from someone we do not happen to hold yet a no-op that reports success.
    await dsarFanoutRepository.addGlobalSuppression(tx, subjectIndex, `dsar:${requestId}`);

    // 3b) LAYER 0 — the shared graph (Phase 5: "erasure = tombstone event + graph reprocess").
    //
    // Steps 1-3 erase the per-workspace OVERLAY. Without this the golden node survives, and the next import
    // of the same person re-mints a live contact from it: the subject reappears, and only the deny list
    // stands between them and being sold again. Suppression rather than deletion — deleting the golden row
    // orphans every overlay bridge pointing at it AND destroys the only record that this identity must never
    // be re-minted, so the next crawl would recreate it clean.
    const masterPersonIds = await dsarFanoutRepository.findMasterPersons(tx, subjectIndex);
    const masterPersonsSuppressed = await dsarFanoutRepository.suppressMasterPersons(
      tx,
      masterPersonIds,
    );
    for (const masterPersonId of masterPersonIds) {
      // The tombstone EVENT, not a deletion of the subject's history: provenance_event is append-only, and a
      // projector replaying the stream has to learn the tail is void. A deleted history would replay straight
      // back into a live person.
      await dsarFanoutRepository.appendTombstoneEvent(tx, masterPersonId, requestId);
    }

    // 4) Verification scan — `completed` ONLY when zero residual PII remains (08 §4.2 step 6), now including
    //    Layer 0. Before this the fan-out could report a completed erasure while the shared graph still held
    //    the subject, which is precisely the false claim the scan exists to prevent.
    const overlay = await dsarFanoutRepository.scanResiduals(
      tx,
      subjectIndex,
      liveCopies.map((c) => c.contactId),
    );
    // `masterPersonIds` is passed so the scan can check the stores that are reachable only BY NODE, not by
    // the subject's key — person-subject `master_signals` rows. Suppression has already deleted the blind
    // index that resolved those nodes, so after the fact there is deliberately no path back from the key to
    // the node; the ids resolved in step 3 are the only handle left.
    const masterResiduals = await dsarFanoutRepository.scanMasterResiduals(
      tx,
      subjectIndex,
      masterPersonIds,
    );
    const verification = { ...overlay, masterResiduals };
    const clean =
      verification.liveCopies === 0 &&
      verification.piiOnTombstones === 0 &&
      verification.dependents === 0 &&
      verification.masterResiduals === 0;
    await dsarRequestRepository.setStatus(tx, requestId, clean ? "completed" : "processing", {
      scopeReport: {
        erased: liveCopies.length,
        masterPersonsSuppressed,
        verification,
      },
      ...(clean ? { completedAt: new Date() } : {}),
    });

    return {
      requestId,
      copiesErased: liveCopies.length,
      masterPersonsSuppressed,
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
