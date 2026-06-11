// deleteFanout.ts — the DSAR delete (08 §4.2, H6): resolve every per-workspace copy of the subject by
// blind index, tombstone each (PII nulled), purge dependents (source_imports / contact_reveals /
// consent_records), add a GLOBAL suppression row, write a per-copy audit + the dsar.delete proof, then a
// VERIFICATION SCAN gates `completed` — idempotent and re-runnable. Runs under the privileged
// leadwolf_admin role (the one sanctioned cross-workspace path); the request must be verified first.

import { dsarFanoutRepository, dsarRequestRepository, withPrivilegedTx } from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { blindIndex } from "../import/blindIndex.ts";
import { writeAudit } from "./writeAudit.ts";

export interface DeleteFanoutResult {
  requestId: string;
  copiesErased: number;
  verification: { liveCopies: number; piiOnTombstones: number; dependents: number };
  completed: boolean;
}

export async function deleteFanout(
  requestId: string,
  subjectEmail: string,
): Promise<DeleteFanoutResult> {
  const subjectIndex = blindIndex(subjectEmail.trim().toLowerCase());

  return withPrivilegedTx(async (tx) => {
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

    return { requestId, copiesErased: liveCopies.length, verification, completed: clean };
  });
}
