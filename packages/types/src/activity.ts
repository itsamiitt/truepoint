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

/** POST /sales-navigator/links — a human pastes the link; nothing is automated against LinkedIn. */
export const salesNavLinkSchema = z.object({
  link_type: salesNavLinkType,
  url: z.string().url().max(500),
  external_id: z.string().max(255).optional(),
  contact_id: z.string().uuid().optional(),
});
export type SalesNavLinkRequest = z.infer<typeof salesNavLinkSchema>;
