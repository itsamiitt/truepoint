// crmErase.ts — the outbound DSAR erase consumer (crm-sync 00 §7.6). One job per crm_record_links row.
//
// Enqueued by the DSAR fan-out AFTER its privileged transaction commits. Each job re-enters withTenantTx for
// the link's own workspace, so the erase — and the link delete that follows a confirmation — are RLS-scoped
// even though the DSAR that scheduled them ran cross-workspace.
//
// The link row is the DSAR's blocking residual, so a failure here is deliberately LOUD: nothing is cleared,
// the residual scan keeps counting, and the request stays `processing` until an operator or a retry gets the
// erase through. See runCrmErase's header for why that ordering is the compliance property.

import { env } from "@leadwolf/config";
import { eraseModeFor, runCrmErase } from "@leadwolf/core";
import type { CrmConnector } from "@leadwolf/core";
import { decryptCrmTokenBundle } from "@leadwolf/core";
import { writeAudit } from "@leadwolf/core";
import { crmConnectionRepository, crmRecordLinkRepository, withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import { log } from "../logger.ts";

export const CRM_ERASE_QUEUE = "crm_sync_erase";

export interface CrmEraseJobData {
  linkId: string;
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  crmObjectType: string;
  crmRecordId: string;
  tpEntityType: string;
  requestId: string;
}

export function makeProcessCrmErase(connectorFor: (p: string) => CrmConnector | undefined) {
  return async function processCrmErase(job: Job<CrmEraseJobData>): Promise<void> {
    const d = job.data;
    const connector = connectorFor(d.provider);
    if (!connector) {
      // No connector means we CANNOT erase. Returning without touching the link is correct: the residual
      // survives and the DSAR stays open rather than silently reporting success.
      log.error("crm erase: no connector configured", { provider: d.provider });
      return;
    }

    const scope = { tenantId: d.tenantId, workspaceId: d.workspaceId };
    const objectType = d.tpEntityType === "account" ? "account" : "contact";

    const result = await withTenantTx(scope, async (tx) =>
      runCrmErase({
        provider: d.provider as "salesforce" | "hubspot",
        objectType,
        linkId: d.linkId,
        crmRecordId: d.crmRecordId,
        mode: eraseModeFor(d.provider as "salesforce" | "hubspot", objectType),
        envEnabled: env.CRM_SYNC_ENABLED,
        connector,
        deps: {
          async loadTokenBundle() {
            const held = await crmConnectionRepository.getEncryptedBundle(tx, d.connectionId);
            if (!held?.oauthTokenEnc) throw new Error("crm erase: connection holds no credential");
            return decryptCrmTokenBundle(held.oauthTokenEnc);
          },
          deleteLink: (linkId) => crmRecordLinkRepository.deleteAfterErase(tx, linkId),
          writeEraseAudit: ({ crmRecordId, mode }) =>
            writeAudit(tx, {
              tenantId: d.tenantId,
              workspaceId: d.workspaceId,
              actorUserId: null, // system: the DSAR job
              action: "crm.erase",
              entityType: "crm_record_links",
              entityId: d.linkId,
              // IDs + provider + mode only. Never the subject's data — this proves WHAT was erased WHERE,
              // and re-recording the person's details in the audit trail would defeat the erasure.
              metadata: { provider: d.provider, crmRecordId, mode, requestId: d.requestId },
            }),
        },
      }),
    );

    if (!result.linkCleared) {
      // Thrown so BullMQ retries: the DSAR cannot complete until this succeeds, so silence would strand the
      // request forever with no signal.
      throw new Error(`crm erase not confirmed: ${result.outcome}:${result.reason ?? ""}`);
    }
  };
}
