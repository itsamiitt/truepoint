// accountRefresh.ts — consumer for ACCOUNT_REFRESH_QUEUE: the customer-triggered company refresh from the
// linkedin_api origin fleet (docs/planning/linkedin-source-ingestion/ §account lane; dark behind
// LINKEDIN_ACCOUNT_REFRESH_ENABLED). All the real logic lives in core's refreshAccount (tx-split reads →
// fetch outside tx → provider_calls ledger → landLinkedinPayload); this file is the thin BullMQ adapter.
//
// Retry taxonomy: "unavailable" (fleet down) THROWS so BullMQ retries with backoff; "rejected" /
// "no_identity" / "not_found" return quietly — a retry cannot change the vendor's answer or conjure an
// identity. A ProviderBudgetExceededError also throws (retry after the daily window is the right shape).

import { env } from "@leadwolf/config";
import { refreshAccount } from "@leadwolf/core";
import type { AccountRefreshJobData } from "@leadwolf/types";
import type { Job } from "bullmq";
import { log } from "../logger.ts";

export async function processAccountRefresh(job: Job<AccountRefreshJobData>): Promise<void> {
  if (!env.LINKEDIN_ACCOUNT_REFRESH_ENABLED) return; // flag flipped off mid-flight → drop quietly

  const { tenantId, workspaceId, accountId, requestedByUserId } = job.data;
  const result = await refreshAccount({
    scope: { tenantId, workspaceId },
    accountId,
    requestedByUserId,
  });

  if (result.status === "unavailable") {
    throw new Error("linkedin_api origin fleet unavailable — retrying");
  }
  log.info("account refresh finished", {
    accountId,
    workspaceId,
    status: result.status,
    cacheHit: "cacheHit" in result ? result.cacheHit : undefined,
  });
}
