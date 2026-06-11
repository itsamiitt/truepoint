// assembleAccessReport.ts — the DSAR access report (08 §4.1): enumerate every per-workspace copy of the
// subject (privileged cross-workspace read) and, per copy, the provenance / reveal / consent footprint.
// The report is stored on the request and delivered to the VERIFIED subject; the access itself is audited
// per copy (dsar.access).

import { dsarFanoutRepository, dsarRequestRepository, withPrivilegedTx } from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { blindIndex } from "../import/blindIndex.ts";
import { writeAudit } from "./writeAudit.ts";

export interface AccessReport {
  requestId: string;
  copies: Array<{
    tenantId: string;
    workspaceId: string;
    isRevealed: boolean;
    sourceImports: number;
    reveals: number;
    consentRecords: number;
  }>;
}

export async function assembleAccessReport(
  requestId: string,
  subjectEmail: string,
): Promise<AccessReport> {
  const subjectIndex = blindIndex(subjectEmail.trim().toLowerCase());

  return withPrivilegedTx(async (tx) => {
    const request = await dsarRequestRepository.getById(tx, requestId);
    if (!request) throw new NotFoundError("DSAR request not found.");
    await dsarRequestRepository.setStatus(tx, requestId, "processing");

    const found = await dsarFanoutRepository.findCopies(tx, subjectIndex);
    const copies: AccessReport["copies"] = [];
    for (const copy of found) {
      const footprint = await dsarFanoutRepository.copyFootprint(tx, copy.contactId);
      copies.push({
        tenantId: copy.tenantId,
        workspaceId: copy.workspaceId,
        isRevealed: copy.isRevealed,
        ...footprint,
      });
      await writeAudit(tx, {
        tenantId: copy.tenantId,
        workspaceId: copy.workspaceId,
        actorUserId: null,
        action: "dsar.access",
        entityType: "contact",
        entityId: copy.contactId,
        metadata: { requestId },
      });
    }

    const report: AccessReport = { requestId, copies };
    await dsarRequestRepository.setStatus(tx, requestId, "completed", {
      scopeReport: report,
      completedAt: new Date(),
    });
    return report;
  });
}
