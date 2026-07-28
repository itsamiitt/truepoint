// crmSync.ts — the four CRM-sync consumers (crm-sync 00 §3.2). Thin delegates: each opens a run row,
// re-enters withTenantTx for the job's tenant, resolves the gates, builds the injected deps, calls the pure
// runner, and closes the run. All the decisions live in @leadwolf/core; nothing here decides anything.
//
// EVERY JOB RE-ENTERS withTenantTx FROM ITS PAYLOAD SCOPE. The scope is the only tenancy input, it came
// from the producer that was itself tenant-scoped, and RLS enforces it regardless — a worker that skipped
// this would run as the owner and see every tenant's rows.
//
// THE GATES ARE RESOLVED FIRST, THEN THE RUN ROW IS OPENED — and closed on every path, including a
// refusal. The order matters: the run's `mode` column is a SNAPSHOT of the connection's syncMode at run
// time, and it is what later distinguishes "shadow counted this" from "enforce wrote this". Opening the
// row first would mean stamping a placeholder mode, which is the exact inaccuracy the column exists to
// prevent. A gated run still gets a row — one that reports `cancelled` with zero records because the
// tenant flag was off is a useful, auditable fact; a job that vanishes without a trace is not.
//
// PAYLOADS ARE PARSED, NOT TRUSTED. Each processor parses its Zod schema first: a job body is data that
// has round-tripped through Redis, and the schemas are the shared contract in @leadwolf/types.

import { applyInboundEvent, runCrmBackfillPage, runCrmDelta, runCrmPush } from "@leadwolf/core";
import type { CrmBudgetStore, CrmConnector } from "@leadwolf/core";
import { withTenantTx } from "@leadwolf/db";
import { crmSyncRunRepository, crmSyncStateRepository } from "@leadwolf/db";
import {
  type CrmBackfillJob,
  type CrmInboundJob,
  type CrmPullJob,
  type CrmPushJob,
  crmBackfillJobSchema,
  crmInboundJobSchema,
  crmPullJobSchema,
  crmPushJobSchema,
} from "@leadwolf/types";
import type { Job } from "bullmq";
import {
  type CrmJobContext,
  crmOverlapMs,
  makeInboundDeps,
  makePullDeps,
  makePushDeps,
  resolveGates,
} from "../crm/crmRunnerDeps.ts";
import { log } from "../logger.ts";

export const CRM_SYNC_PULL_QUEUE = "crm_sync_pull";
export const CRM_SYNC_INBOUND_QUEUE = "crm_sync_inbound";
export const CRM_SYNC_PUSH_QUEUE = "crm_sync_push";
export const CRM_SYNC_BACKFILL_QUEUE = "crm_sync_backfill";

/** The connector registry, injected at registration so the consumers stay adapter-agnostic. */
export type CrmConnectorLookup = (provider: string) => CrmConnector | undefined;

/** Page size per pull. Kept well under both providers' batch ceilings (SFDC 200 / HubSpot 100). */
const PAGE_SIZE = 100;

/**
 * How far back a RECONCILE re-reads (§3.3). Seven days: wide enough to cover a multi-day provider outage or
 * a bug that went unnoticed over a weekend, narrow enough that the daily backstop stays a bounded number of
 * API calls rather than a full-table scan against a rate-limited provider. A gap older than this needs a
 * backfill, which is a deliberate operator action.
 */
const RECONCILE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * Map a runner's outcome onto the run ledger's closed status enum.
 *
 * A GATED job closes as `cancelled`, not `failed`: nothing went wrong, the engine is simply off for this
 * tenant, and a health surface that showed those as failures would cry wolf on every dark tenant.
 */
export function runStatusForOutcome(
  outcome: string,
): "completed" | "partial" | "failed" | "cancelled" {
  if (outcome === "gated") return "cancelled";
  if (outcome === "failed") return "failed";
  if (outcome === "partial" || outcome === "rate_limited") return "partial";
  return "completed";
}

/** crm-sync-push — one TP contact out to the CRM. */
export function makeProcessCrmPush(connectorFor: CrmConnectorLookup, budget?: CrmBudgetStore) {
  return async function processCrmPush(job: Job<CrmPushJob>): Promise<void> {
    const data = crmPushJobSchema.parse(job.data);
    const connector = connectorFor(data.provider);
    if (!connector) {
      log.error("crm push: no connector configured", { provider: data.provider });
      return;
    }

    await withTenantTx(data.scope, async (tx) => {
      // Gates FIRST, so the run row's `mode` is the connection's real mode rather than a placeholder.
      const gates = await resolveGates(tx, {
        tenantId: data.scope.tenantId,
        connectionId: data.connectionId,
      });
      const runId = await crmSyncRunRepository.start(tx, {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        provider: data.provider,
        objectType: data.objectType,
        direction: "outbound",
        trigger: "manual",
        mode: gates.syncMode,
      });
      const ctx: CrmJobContext = {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        runId,
      };

      const result = await runCrmPush({
        provider: data.provider,
        objectType: data.objectType,
        tpEntityId: data.tpEntityId,
        // The TP uuid is written to this CRM field so the upsert is idempotent across retries.
        externalIdField: "TruePoint_Id__c",
        gates,
        connector,
        deps: makePushDeps(tx, ctx, data.tpEntityId, budget),
      });

      await crmSyncRunRepository.finish(tx, runId, runStatusForOutcome(result.outcome), {
        failedReason: result.reason ?? null,
      });
    });
  };
}

/** crm-sync-inbound — a webhook/CDC hint: re-fetch the canonical record and apply it. */
export function makeProcessCrmInbound(connectorFor: CrmConnectorLookup) {
  return async function processCrmInbound(job: Job<CrmInboundJob>): Promise<void> {
    const data = crmInboundJobSchema.parse(job.data);
    const connector = connectorFor(data.provider);
    if (!connector) {
      log.error("crm inbound: no connector configured", { provider: data.provider });
      return;
    }

    await withTenantTx(data.scope, async (tx) => {
      const gates = await resolveGates(tx, {
        tenantId: data.scope.tenantId,
        connectionId: data.connectionId,
      });
      const runId = await crmSyncRunRepository.start(tx, {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        provider: data.provider,
        objectType: data.objectType,
        direction: "inbound",
        trigger: "webhook",
        mode: gates.syncMode,
      });
      const ctx: CrmJobContext = {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        runId,
      };

      const result = await applyInboundEvent({
        provider: data.provider,
        objectType: data.objectType,
        crmRecordId: data.crmRecordId,
        sourceTag: data.sourceTag ?? null,
        // Our own origin tag: an event carrying it is our write echoed back (§6.6 loop guard 1).
        ownSourceTag: "truepoint",
        gates,
        connector,
        deps: makeInboundDeps(tx, ctx, data.objectType === "account" ? "account" : "contact"),
      });

      await crmSyncRunRepository.finish(tx, runId, runStatusForOutcome(result.outcome), {
        failedReason: result.reason ?? null,
      });
    });
  };
}

/** crm-sync-pull — the incremental delta for one (connection, object). */
export function makeProcessCrmPull(connectorFor: CrmConnectorLookup) {
  return async function processCrmPull(job: Job<CrmPullJob>): Promise<void> {
    const data = crmPullJobSchema.parse(job.data);
    const connector = connectorFor(data.provider);
    if (!connector) {
      log.error("crm pull: no connector configured", { provider: data.provider });
      return;
    }

    await withTenantTx(data.scope, async (tx) => {
      const state = await crmSyncStateRepository.getOrCreate(
        tx,
        data.scope,
        data.connectionId,
        data.objectType,
        "inbound",
      );
      // A RECONCILE ignores the stored watermark and re-reads a wide window (§3.3). The watermark is only as
      // correct as everything that advanced it: a missed webhook, a provider outage or a bug in our own apply
      // path leaves a gap BELOW the mark that no delta poll will ever ask for again. Re-reading is cheap —
      // the link table and content hashes make re-application a no-op — so the backstop costs API calls only.
      const { since: deltaSince } = await crmSyncStateRepository.readWithOverlap(
        tx,
        state.id,
        crmOverlapMs(),
      );
      const since = data.reconcile ? new Date(Date.now() - RECONCILE_LOOKBACK_MS) : deltaSince;

      const gates = await resolveGates(tx, {
        tenantId: data.scope.tenantId,
        connectionId: data.connectionId,
      });
      const runId = await crmSyncRunRepository.start(tx, {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        provider: data.provider,
        objectType: data.objectType,
        direction: "inbound",
        trigger: data.reconcile ? "replay" : "scheduled",
        mode: gates.syncMode,
        watermarkBefore: state.watermark,
      });
      const ctx: CrmJobContext = {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        runId,
      };
      const inbound = makeInboundDeps(
        tx,
        ctx,
        data.objectType === "account" ? "account" : "contact",
      );

      const result = await runCrmDelta({
        provider: data.provider,
        objectType: data.objectType,
        pageSize: PAGE_SIZE,
        since,
        gates,
        connector,
        deps: makePullDeps(tx, ctx, state.id, (record) =>
          // Each pulled record goes through the SAME apply path a webhook would take, so the merge, the
          // suppression wall and the conflict staging behave identically whichever door a record came in by.
          applyInboundEvent({
            provider: data.provider,
            objectType: data.objectType,
            crmRecordId: String(
              (record as { Id?: string; id?: string }).Id ?? (record as { id?: string }).id ?? "",
            ),
            gates,
            connector,
            deps: inbound,
          }),
        ),
      });

      await crmSyncRunRepository.finish(tx, runId, runStatusForOutcome(result.outcome), {
        watermarkAfter: result.watermark ?? null,
        failedReason: result.reason ?? null,
      });
    });
  };
}

/** crm-sync-backfill — one page of the initial bulk load; `more` means the caller enqueues the next. */
export function makeProcessCrmBackfill(
  connectorFor: CrmConnectorLookup,
  enqueueNextPage: (job: CrmBackfillJob) => Promise<unknown>,
) {
  return async function processCrmBackfill(job: Job<CrmBackfillJob>): Promise<void> {
    const data = crmBackfillJobSchema.parse(job.data);
    const connector = connectorFor(data.provider);
    if (!connector) {
      log.error("crm backfill: no connector configured", { provider: data.provider });
      return;
    }

    await withTenantTx(data.scope, async (tx) => {
      const state = await crmSyncStateRepository.getOrCreate(
        tx,
        data.scope,
        data.connectionId,
        data.objectType,
        "inbound",
      );

      const gates = await resolveGates(tx, {
        tenantId: data.scope.tenantId,
        connectionId: data.connectionId,
      });

      // A `page` job carries the run id the `drive` job opened, so one backfill is ONE run row across every
      // page — otherwise a 40-page backfill would look like 40 separate runs on the health surface.
      const runId =
        data.kind === "page" && data.runId
          ? data.runId
          : await crmSyncRunRepository.start(tx, {
              tenantId: data.scope.tenantId,
              workspaceId: data.scope.workspaceId,
              connectionId: data.connectionId,
              provider: data.provider,
              objectType: data.objectType,
              direction: "inbound",
              trigger: "backfill",
              mode: gates.syncMode,
            });

      const ctx: CrmJobContext = {
        tenantId: data.scope.tenantId,
        workspaceId: data.scope.workspaceId,
        connectionId: data.connectionId,
        runId,
      };
      const inbound = makeInboundDeps(
        tx,
        ctx,
        data.objectType === "account" ? "account" : "contact",
      );

      const result = await runCrmBackfillPage({
        provider: data.provider,
        objectType: data.objectType,
        pageSize: PAGE_SIZE,
        cursor: data.kind === "page" ? data.cursor : undefined,
        gates,
        connector,
        deps: makePullDeps(tx, ctx, state.id, (record) =>
          applyInboundEvent({
            provider: data.provider,
            objectType: data.objectType,
            crmRecordId: String(
              (record as { Id?: string; id?: string }).Id ?? (record as { id?: string }).id ?? "",
            ),
            gates,
            connector,
            deps: inbound,
          }),
        ),
      });

      if (result.outcome === "more" && result.nextCursor) {
        // The follow-up is ENQUEUED rather than looped, so a large backfill yields between pages instead of
        // monopolising a worker and starving real-time jobs (00 §8).
        await enqueueNextPage({
          kind: "page",
          scope: data.scope,
          connectionId: data.connectionId,
          provider: data.provider,
          objectType: data.objectType,
          runId,
          cursor: result.nextCursor,
        });
        return; // the run stays `running` until the last page closes it
      }

      await crmSyncRunRepository.finish(tx, runId, runStatusForOutcome(result.outcome), {
        watermarkAfter: result.watermark ?? null,
        failedReason: result.reason ?? null,
      });
    });
  };
}
