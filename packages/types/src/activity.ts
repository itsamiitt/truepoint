// activity.ts — shared vocabulary for the per-contact activity timeline (05 §10, M8) and Sales Navigator
// link capture (05 §5, M7): closed enums mirroring the 03 §7 CHECK constraints, the request schemas the
// api routes zod-parse, and the timeline row DTO. Validation lives here; logic does not.

import { z } from "zod";

// ── Activity enums (mirror the activities CHECK constraints) ───────────────────────────────────────────
export const activityType = z.enum([
  "email_sent",
  "email_opened",
  "email_clicked",
  "email_replied",
  "call_made",
  "call_connected",
  "linkedin_message",
  "linkedin_connected",
  "sales_nav_inmail",
  "meeting_held",
  "note_added",
]);
export type ActivityType = z.infer<typeof activityType>;

export const activityChannel = z.enum([
  "email",
  "phone",
  "linkedin",
  "sales_navigator",
  "in-person",
]);
export type ActivityChannel = z.infer<typeof activityChannel>;

/** Optional per-activity result — bound to a closed list so reporting can aggregate it. */
export const activityOutcome = z.enum([
  "connected",
  "voicemail",
  "no_answer",
  "positive",
  "negative",
  "neutral",
]);
export type ActivityOutcome = z.infer<typeof activityOutcome>;

// ── Requests ───────────────────────────────────────────────────────────────────────────────────────────
/** POST /contacts/:id/activities — manual logging (notes/calls/meetings); occurred_at is ISO-8601. */
export const logActivitySchema = z.object({
  activity_type: activityType,
  channel: activityChannel,
  outcome: activityOutcome.optional(),
  note: z.string().max(2000).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export type LogActivityRequest = z.infer<typeof logActivitySchema>;

// ── Timeline DTO (GET /contacts/:id/activities) ────────────────────────────────────────────────────────
export interface ActivityRow {
  id: string;
  contactId: string;
  actorUserId: string | null; // null = system-generated (send engine, sync)
  activityType: ActivityType;
  channel: ActivityChannel;
  outcome: ActivityOutcome | null;
  note: string | null;
  occurredAt: Date;
}

// ── Sales Navigator links (05 §5, M7 — HITL capture, ADR-0009) ─────────────────────────────────────────
export const salesNavLinkType = z.enum([
  "profile",
  "account",
  "saved_search",
  "lead_list",
  "account_list",
  "inmail_thread",
]);
export type SalesNavLinkType = z.infer<typeof salesNavLinkType>;

/**
 * A free-text label (tag) on a captured link. Bounded + non-empty so the chip list stays meaningful and a
 * caller can't paste an essay as a "label". Trimmed at the edge so " sdr " and "sdr" collapse.
 */
export const salesNavLabel = z.string().trim().min(1).max(40);

/**
 * POST /sales-navigator/links — a human pastes the link; nothing is automated against LinkedIn (ADR-0009).
 * `note`/`labels` are the optional capture metadata; `external_id` may carry a sales_nav_lead_id the human
 * already knows, but the server also parses one from a `/sales/lead/...` URL when omitted.
 */
export const salesNavLinkSchema = z.object({
  link_type: salesNavLinkType,
  url: z.string().url().max(500),
  // Trimmed; a blank/whitespace-only value is dropped (→ undefined) so it never becomes an empty-string
  // dedup key in the (workspace_id, sales_nav_lead_id) index.
  external_id: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v ? v : undefined)),
  contact_id: z.string().uuid().optional(),
  note: z.string().trim().max(2000).optional(),
  labels: z.array(salesNavLabel).max(20).optional(),
});
export type SalesNavLinkRequest = z.infer<typeof salesNavLinkSchema>;

/** One captured link as the list view (GET /sales-navigator/links) renders it. No PII; workspace-scoped. */
export interface SalesNavLinkDTO {
  id: string;
  linkType: SalesNavLinkType;
  url: string;
  externalId: string | null;
  note: string | null;
  labels: string[];
  contactId: string | null;
  accountId: string | null;
  capturedAt: string; // ISO-8601 — when the human captured it (defaults to insert time)
  createdAt: string; // ISO-8601 — the row's creation timestamp
}

/** POST /sales-navigator/links response: the new id, plus whether an identical (workspace_id, url) already existed. */
export interface SalesNavCaptureResult {
  id: string;
  deduped: boolean;
}
