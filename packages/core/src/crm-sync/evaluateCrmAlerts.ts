// evaluateCrmAlerts.ts — the PURE alert judgement for CRM sync (crm-sync 00 §9.5).
//
// The plan is explicit that observability rides the DB ledger + structured logs + a leader-locked tick, not
// a new metrics or paging backend. So this decides WHAT is worth saying; the tick decides when to say it.
//
// THE HARD PART IS NOT DETECTING PROBLEMS — every input here is a count someone could eyeball. It is
// deciding what does NOT deserve an alert, because an operator console that fires on normal states gets
// muted, and a muted alert channel is worse than none: it converts a real incident into silence people have
// already learned to ignore.
//
// So the rules below are deliberately conservative, and each carries the reason it is set where it is:
//   - `shadow` is the DEFAULT state of every new connection. Never an alert.
//   - A single dead-letter row is a poison record, not an outage. Only a RATE worth investigating alerts.
//   - A stale watermark is only meaningful against the stream's OWN cadence: a connection polled every 60s
//     that has not advanced in an hour is stuck; one that legitimately has no changes is not.
//   - A rate-limited connection is HEALTHY. The provider asked us to slow down and we did.

export type CrmAlertSeverity = "warn" | "critical";

export interface CrmAlert {
  severity: CrmAlertSeverity;
  /** A stable code, safe to log and to match on — never an interpolated sentence. */
  code:
    | "connection_error"
    | "token_expired"
    | "dead_letter_rate"
    | "conflict_backlog"
    | "watermark_stalled";
  connectionId: string;
  tenantId: string;
  workspaceId: string;
  /** PII-free facts an operator needs to act, as scalars rather than prose. */
  facts: Record<string, string | number>;
}

/** One connection's observable state, as the tick reads it. Counts + timestamps; never customer data. */
export interface CrmConnectionSnapshot {
  connectionId: string;
  tenantId: string;
  workspaceId: string;
  status: string;
  syncMode: string;
  tokenExpiresAt: Date | null;
  /** Open dead-letter rows for this connection. */
  deadLetters: number;
  /** Open conflicts awaiting human arbitration. */
  openConflicts: number;
  /** The newest inbound watermark across the connection's streams; null before the first successful sync. */
  newestWatermark: Date | null;
}

export interface CrmAlertThresholds {
  /** Open dead-letters above which a connection is worth investigating. */
  deadLetterCount: number;
  /** Open conflicts above which the review queue is being ignored rather than worked. */
  conflictBacklog: number;
  /** How long a CONNECTED, enforcing stream may go without advancing before it looks stuck. */
  watermarkStallMs: number;
}

export const DEFAULT_CRM_ALERT_THRESHOLDS: CrmAlertThresholds = {
  // Not 1. A single poison record is a data problem on one row, not an outage — alerting on it would fire
  // constantly on healthy connections with one malformed CRM record nobody has cleaned up.
  deadLetterCount: 10,
  // A handful of conflicts is the feature working: it means humans have edits worth protecting. A large
  // standing backlog means nobody is working the queue, which is the actual thing worth saying.
  conflictBacklog: 50,
  // Six hours. Long enough that a quiet weekend or a slow provider does not fire; short enough that a
  // genuinely stuck stream is caught the same working day.
  watermarkStallMs: 6 * 60 * 60_000,
};

/**
 * Judge one connection.
 *
 * Returns every applicable alert rather than the first: a connection can be both errored AND backlogged,
 * and reporting only the first would hide the second until the first is fixed.
 */
export function evaluateCrmConnection(
  snapshot: CrmConnectionSnapshot,
  thresholds: CrmAlertThresholds = DEFAULT_CRM_ALERT_THRESHOLDS,
  now: number = Date.now(),
): CrmAlert[] {
  const alerts: CrmAlert[] = [];
  const base = {
    connectionId: snapshot.connectionId,
    tenantId: snapshot.tenantId,
    workspaceId: snapshot.workspaceId,
  };

  // A disconnected or paused connection is a deliberate state, not a fault. Nothing below applies to it —
  // and returning early matters: a paused connection's watermark is stale BY DESIGN, and alerting on that
  // would fire forever on every connection an operator deliberately switched off.
  if (snapshot.status === "disconnected" || snapshot.status === "paused") return alerts;

  if (snapshot.status === "error") {
    alerts.push({ ...base, severity: "critical", code: "connection_error", facts: {} });
  }

  if (snapshot.tokenExpiresAt && snapshot.tokenExpiresAt.getTime() <= now) {
    // Critical because it presents as intermittent provider failures until someone notices the expiry —
    // the refresh sweep should have prevented it, so reaching here means the refresh path is also broken.
    alerts.push({
      ...base,
      severity: "critical",
      code: "token_expired",
      facts: { expiredAt: snapshot.tokenExpiresAt.toISOString() },
    });
  }

  if (snapshot.deadLetters >= thresholds.deadLetterCount) {
    alerts.push({
      ...base,
      severity: "warn",
      code: "dead_letter_rate",
      facts: { open: snapshot.deadLetters, threshold: thresholds.deadLetterCount },
    });
  }

  if (snapshot.openConflicts >= thresholds.conflictBacklog) {
    alerts.push({
      ...base,
      severity: "warn",
      code: "conflict_backlog",
      facts: { open: snapshot.openConflicts, threshold: thresholds.conflictBacklog },
    });
  }

  // A stalled watermark only means something for a connection that is actually supposed to be syncing.
  // A `shadow` connection still pulls, so it IS included; a `disabled` one is not, because it is not
  // trying to advance anything.
  if (
    snapshot.status === "connected" &&
    snapshot.syncMode !== "disabled" &&
    snapshot.newestWatermark &&
    now - snapshot.newestWatermark.getTime() >= thresholds.watermarkStallMs
  ) {
    alerts.push({
      ...base,
      severity: "warn",
      code: "watermark_stalled",
      facts: {
        stalledForMs: now - snapshot.newestWatermark.getTime(),
        watermark: snapshot.newestWatermark.toISOString(),
      },
    });
  }

  return alerts;
}

/** Judge the fleet. Flat list so the tick can log a bounded summary rather than one line per connection. */
export function evaluateCrmAlerts(
  snapshots: CrmConnectionSnapshot[],
  thresholds: CrmAlertThresholds = DEFAULT_CRM_ALERT_THRESHOLDS,
  now: number = Date.now(),
): CrmAlert[] {
  return snapshots.flatMap((s) => evaluateCrmConnection(s, thresholds, now));
}

/** Counts per code — what the tick actually logs, so a fleet-wide incident is one line, not N. */
export function summariseCrmAlerts(alerts: CrmAlert[]): {
  total: number;
  critical: number;
  byCode: Record<string, number>;
} {
  const byCode: Record<string, number> = {};
  let critical = 0;
  for (const a of alerts) {
    byCode[a.code] = (byCode[a.code] ?? 0) + 1;
    if (a.severity === "critical") critical += 1;
  }
  return { total: alerts.length, critical, byCode };
}
