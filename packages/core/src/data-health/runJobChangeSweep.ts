// runJobChangeSweep.ts — the per-workspace runner for the S-13 job-change fan-out (intelligence-platform
// 07 §4 slice 7.1; outcomes S-09, S-13, S-14).
//
// This is the WIRE, not the judgement. Everything it composes already shipped and is tested in isolation:
//   detectJobChange  — decides, by comparing confidences (packages/core/src/data-health/jobChange.ts)
//   recordJobChange  — persists the signal + alerts only the users who saved the contact
// The runner's whole job is to put the Layer-0 observation next to the Layer-1 belief and hand both to the
// decision function. It deliberately re-decides nothing: a second copy of the rule is a second rule.
//
// THE PRIOR IS DELIBERATELY CONSERVATIVE. A tenant contact carries no method and no corroboration count, so
// its prior is priced with an unknown method (DEFAULT_METHOD_PRIOR — provider-grade, the middle of the
// ladder, never the top) and a single source, aged by contacts.last_verified_at. That is the honest reading
// of "we believe this because someone put it there", and it sets the bar so a STRONG new claim can clear it
// while a weak one cannot. Pricing the prior at the top would freeze every record; pricing it at the bottom
// would let one crawl overwrite the database.

import { type Tx, jobChangeSweepRepository, withTenantTx } from "@leadwolf/db";
import type { ObservedEmployment } from "@leadwolf/db";
import { detectJobChange } from "./jobChange.ts";
import { recordJobChange } from "./recordJobChange.ts";

export interface JobChangeSweepScope {
  tenantId: string;
  workspaceId: string;
}

export interface JobChangeSweepOptions {
  /** Contacts per keyset batch. */
  batchSize: number;
  /** Batches per tick, so a whale workspace drains across ticks instead of blocking one. */
  maxBatches: number;
}

export interface JobChangeSweepResult {
  scanned: number;
  /** Verdicts where `changed` was true — signals written. */
  detected: number;
  /** Notifications actually delivered (watchers only, deduped per user+contact). */
  notified: number;
  batches: number;
  /** True when the workspace ran out of candidates inside this tick's batch budget. */
  drained: boolean;
}

/**
 * Evaluate one workspace's contacts against the Layer-0 employment the census already found had moved.
 *
 * `observed` is passed IN rather than read here on purpose: master_employment is Layer 0 and REVOKE'd from
 * leadwolf_app, so it cannot be joined from inside a tenant transaction. The sweep reads it once on the owner
 * connection and carries the facts across — which is also why this function needs no Layer-0 access of its own.
 */
export async function runJobChangeSweepForWorkspace(
  scope: JobChangeSweepScope,
  observed: ReadonlyMap<string, ObservedEmployment>,
  opts: JobChangeSweepOptions,
): Promise<JobChangeSweepResult> {
  const masterPersonIds = [...observed.keys()];
  let scanned = 0;
  let detected = 0;
  let notified = 0;
  let batches = 0;
  let drained = false;
  let afterId: string | null = null;

  while (batches < opts.maxBatches) {
    // One transaction per batch: a failure loses that batch, not the workspace, and the census re-surfaces
    // the workspace next tick. RLS is ENFORCING here — this is the only place the sweep writes.
    const batch = await withTenantTx(scope, async (tx: Tx) => {
      const candidates = await jobChangeSweepRepository.loadJobChangeCandidates(
        tx,
        masterPersonIds,
        { afterId, limit: opts.batchSize },
      );
      let batchDetected = 0;
      let batchNotified = 0;

      for (const candidate of candidates) {
        const obs = observed.get(candidate.masterPersonId);
        // The census matched on the person, so this is normally present; a missing entry means the edge moved
        // again between census and read. Skipping is correct — the next tick sees the newer state.
        if (!obs) continue;

        const verdict = detectJobChange(
          {
            companyId: candidate.masterCompanyId,
            title: candidate.jobTitle,
            // No method recorded on the overlay row — DEFAULT_METHOD_PRIOR applies. See the header.
            method: null,
            ageDays: candidate.priorAgeDays,
            distinctSources: 1,
          },
          {
            companyId: obs.masterCompanyId,
            title: obs.title,
            method: obs.matchMethod,
            ageDays: obs.ageDays,
            distinctSources: obs.sourceCount,
          },
        );

        const res = await recordJobChange(tx, {
          scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
          contactId: candidate.contactId,
          contactLabel: candidate.label,
          newCompanyName: obs.companyName,
          verdict,
        });
        if (res.signalRecorded) batchDetected += 1;
        batchNotified += res.notified;
      }

      return {
        count: candidates.length,
        lastId: candidates.at(-1)?.contactId ?? null,
        detected: batchDetected,
        notified: batchNotified,
      };
    });

    scanned += batch.count;
    detected += batch.detected;
    notified += batch.notified;
    batches += 1;

    // A short batch means the keyset reached the end of this workspace's candidates.
    if (batch.count < opts.batchSize || !batch.lastId) {
      drained = true;
      break;
    }
    afterId = batch.lastId;
  }

  return { scanned, detected, notified, batches, drained };
}
