// crmDeadLetterRepository.ts — the PII-free poison-job DLQ (crm-sync 00 §4.8).
// WORKSPACE-scoped, APPEND-ONLY for the app role (rls/crm.sql grants SELECT + INSERT only).
//
// Written ONLY after BullMQ's retries are exhausted, so a row here means "this job will never succeed on its
// own" rather than "something went wrong once". That distinction is what makes the queue readable: a DLQ
// that also collected transient blips would be noise an operator learns to ignore.
//
// THE PII RULE IS ENFORCED HERE, not left to callers. `error_detail` carries a provider code or a short
// reason and NEVER a field value, and `tp_entity_id` is an id with no FK — the entity may already be
// tombstoned by the DSAR that led here. A dead-letter row is read by staff across tenants on the ops
// console; if it carried the record that failed, the DLQ would quietly become a cross-tenant copy of
// customer data with its own retention story. So the detail is truncated AND scrubbed of the shapes that
// most often smuggle PII into an error string.

import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { crmSyncDeadLetter } from "../schema/crm.ts";

/** The closed error taxonomy (§4.8). Anything unrecognised must map to `unknown`, never be invented. */
export type CrmErrorClass =
  | "rate_limited"
  | "auth"
  | "validation"
  | "conflict_unresolved"
  | "transform"
  | "not_found"
  | "provider_5xx"
  | "ssrf_blocked"
  | "suppressed"
  | "unknown";

const ERROR_CLASSES = new Set<string>([
  "rate_limited",
  "auth",
  "validation",
  "conflict_unresolved",
  "transform",
  "not_found",
  "provider_5xx",
  "ssrf_blocked",
  "suppressed",
  "unknown",
]);

/**
 * Map a runner outcome / error string onto the closed class.
 *
 * Falls back to `unknown` rather than throwing: a dead-letter write is the LAST chance to record that a job
 * failed, and failing that write because the reason string was unfamiliar would lose the evidence entirely.
 */
export function classifyCrmError(reason: string | null | undefined): CrmErrorClass {
  if (!reason) return "unknown";
  if (ERROR_CLASSES.has(reason)) return reason as CrmErrorClass;
  if (reason.startsWith("auth_")) return "auth";
  if (reason === "transient" || reason === "permanent") return "provider_5xx";
  if (reason === "subject_suppressed") return "suppressed";
  if (reason.includes("transform")) return "transform";
  return "unknown";
}

/**
 * Reduce an error message to something safe to store.
 *
 * Emails and long digit runs are the two shapes that most often smuggle PII into a provider error string
 * ("could not update dana@acme.com", "invalid phone 14155552671"). Both are redacted before the truncation,
 * so a message that would have carried an address stores a marker instead. This is a belt-and-braces layer
 * over callers passing codes rather than messages — not a licence to pass raw provider bodies.
 */
export function scrubErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\d{7,}/g, "[number]")
    .slice(0, 1000);
}

export interface CrmDeadLetterInsert {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  runId?: string | null;
  /** The origin queue — the discriminator that tells an operator which lane is failing. */
  queue: string;
  direction?: "inbound" | "outbound" | null;
  objectType?: string | null;
  crmObjectType?: string | null;
  crmRecordId?: string | null;
  tpEntityId?: string | null;
  errorClass: CrmErrorClass;
  errorDetail?: string | null;
  attempts: number;
}

export const crmDeadLetterRepository = {
  /** Record an exhausted job. Detail is scrubbed + truncated on the way in — see the header. */
  async record(tx: Tx, row: CrmDeadLetterInsert): Promise<string> {
    const inserted = await tx
      .insert(crmSyncDeadLetter)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        runId: row.runId ?? null,
        queue: row.queue.slice(0, 40),
        direction: row.direction ?? null,
        objectType: row.objectType ?? null,
        crmObjectType: row.crmObjectType ?? null,
        crmRecordId: row.crmRecordId ?? null,
        tpEntityId: row.tpEntityId ?? null,
        errorClass: row.errorClass,
        errorDetail: scrubErrorDetail(row.errorDetail),
        attempts: row.attempts,
      })
      .returning({ id: crmSyncDeadLetter.id });
    return inserted[0]!.id;
  },

  /** The open dead-letter queue for a workspace, newest first. Index-backed by (workspace, status, created). */
  async listOpen(tx: Tx, limit: number) {
    return tx
      .select({
        id: crmSyncDeadLetter.id,
        connectionId: crmSyncDeadLetter.connectionId,
        queue: crmSyncDeadLetter.queue,
        direction: crmSyncDeadLetter.direction,
        objectType: crmSyncDeadLetter.objectType,
        crmRecordId: crmSyncDeadLetter.crmRecordId,
        errorClass: crmSyncDeadLetter.errorClass,
        errorDetail: crmSyncDeadLetter.errorDetail,
        attempts: crmSyncDeadLetter.attempts,
        firstSeenAt: crmSyncDeadLetter.firstSeenAt,
        lastSeenAt: crmSyncDeadLetter.lastSeenAt,
      })
      .from(crmSyncDeadLetter)
      .where(eq(crmSyncDeadLetter.status, "open"))
      .orderBy(desc(crmSyncDeadLetter.createdAt))
      .limit(limit);
  },

  /** Open dead-letter count for a connection — the sync-health badge. */
  async countOpenForConnection(tx: Tx, connectionId: string): Promise<number> {
    const rows = await tx
      .select({ id: crmSyncDeadLetter.id })
      .from(crmSyncDeadLetter)
      .where(
        and(eq(crmSyncDeadLetter.connectionId, connectionId), eq(crmSyncDeadLetter.status, "open")),
      );
    return rows.length;
  },

  // NOTE: there is no `resolve`/`retry` here on purpose. The table is APPEND-ONLY for leadwolf_app under
  // FORCE RLS, so a status UPDATE from this path would silently affect zero rows — a method that appears to
  // work and does nothing. The staff replay console mutates status on the owner/withPlatformTx path, which
  // the app-role policy wall does not gate (00 §4.8).
};
