// format.ts — the monitor's PURE presentation decisions (crm-sync 00 §9). Extracted so the judgements that
// actually matter — what counts as "needs attention" — are unit-testable without a browser.

import type { StaffCrmConnection } from "./types";

export type HealthTone = "success" | "warning" | "danger" | "muted";

export interface ConnectionHealth {
  tone: HealthTone;
  label: string;
  /** True when an operator should look at this row now. Drives the "needs attention" filter. */
  needsAttention: boolean;
}

/**
 * Classify one connection for the fleet table.
 *
 * The ordering of these checks is the judgement. An `error` status outranks everything: a connection that
 * cannot talk to its CRM is broken regardless of what mode it is in. An EXPIRED token is next, because it
 * produces failures that look like intermittent provider problems until someone notices the expiry.
 *
 * `shadow` is explicitly NOT an alert. Every connection starts there by design, and a monitor that flagged
 * the default state would be permanently red and therefore ignored — the classic alert-fatigue failure. It
 * is surfaced as information ("Preview") so an operator can see a pilot that has been sitting unpromoted,
 * without it competing with real breakage.
 */
export function classifyConnection(conn: StaffCrmConnection, now: number): ConnectionHealth {
  if (conn.status === "error") {
    return { tone: "danger", label: "Error", needsAttention: true };
  }
  if (conn.status === "disconnected") {
    return { tone: "muted", label: "Disconnected", needsAttention: false };
  }
  if (conn.status === "pending") {
    return { tone: "muted", label: "Pending", needsAttention: false };
  }
  if (conn.status === "paused") {
    return { tone: "muted", label: "Paused", needsAttention: false };
  }
  // status === 'connected' from here.
  if (conn.tokenExpiresAt && Date.parse(conn.tokenExpiresAt) <= now) {
    return { tone: "danger", label: "Token expired", needsAttention: true };
  }
  if (conn.syncMode === "disabled") {
    return { tone: "muted", label: "Sync off", needsAttention: false };
  }
  if (conn.syncMode === "shadow") {
    return { tone: "warning", label: "Preview", needsAttention: false };
  }
  return { tone: "success", label: "Syncing", needsAttention: false };
}

/** Rows an operator should act on, most urgent first. */
export function needsAttention(
  connections: StaffCrmConnection[],
  now: number,
): StaffCrmConnection[] {
  return connections.filter((c) => classifyConnection(c, now).needsAttention);
}

export const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
