// crmAlertTick.ts — the fleet health evaluation (crm-sync 00 §9.5).
//
// The plan is explicit that observability rides the DB ledger + structured logs + a leader-locked tick, not
// a new metrics or paging backend. So this reads the ledger, asks the pure evaluator what is worth saying,
// and says it once.
//
// IT LOGS A SUMMARY, NOT ONE LINE PER CONNECTION. A fleet-wide incident — a provider outage, an expired
// signing secret — would otherwise produce hundreds of identical lines that bury the one fact an operator
// needs (how many, of what). Per-connection detail is available on the staff monitor; the log is the
// signal, not the report.
//
// IT IS SILENT WHEN HEALTHY. A tick that logs "all clear" every 60 seconds trains people to filter the
// channel, which is exactly how a real alert gets missed.
//
// The reads run on the OWNER connection (cross-tenant, like every sweep here) and project COUNTS ONLY —
// no credential, no customer data. The evaluator's facts are scalars for the same reason.

import { evaluateCrmAlerts, summariseCrmAlerts } from "@leadwolf/core";
import type { CrmAlert } from "@leadwolf/core";
import { crmHealthRepository } from "@leadwolf/db";
import { log } from "../logger.ts";

/** Evaluate the fleet and log what is worth saying. Called by the sweep's `alert` tick, under its lock. */
export async function runCrmAlertTick(limit: number): Promise<void> {
  const snapshots = await crmHealthRepository.fleetSnapshot(limit);
  if (snapshots.length === 0) return;

  const alerts = evaluateCrmAlerts(snapshots);
  const summary = summariseCrmAlerts(alerts);
  if (summary.total === 0) return; // silent when healthy — see the header

  log.warn("crm sync: connections need attention", {
    connections: snapshots.length,
    alerts: summary.total,
    critical: summary.critical,
    byCode: summary.byCode,
  });

  // The CRITICAL rows get their ids too, bounded: an operator needs somewhere to start, and a handful of
  // connection ids is a starting point rather than a dump. Ids only — never a tenant name or any record.
  const criticalIds = alerts.filter((a: CrmAlert) => a.severity === "critical").slice(0, 20);
  for (const a of criticalIds) {
    log.error("crm sync: critical connection alert", {
      code: a.code,
      connectionId: a.connectionId,
      workspaceId: a.workspaceId,
      ...a.facts,
    });
  }
}
