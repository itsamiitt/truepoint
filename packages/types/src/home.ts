// home.ts — the Zod schema + inferred types for the Home dashboard summary DTO. Single source of truth
// shared by apps/api (the /home/summary route) and apps/web (the Home feature). PII never appears here:
// hotLeads carry facets only, the activity feed carries minimized columns only. Validation lives here.

import { z } from "zod";
import { revealType } from "./billing.ts";

// ── Credit burn sparkline (per-day consumption) ────────────────────────────────────────────────────────
export const burnPointSchema = z.object({
  day: z.string(), // YYYY-MM-DD
  credits: z.number().int().min(0),
});
export type BurnPoint = z.infer<typeof burnPointSchema>;

// ── Recent reveals (most recent first, max 10) ─────────────────────────────────────────────────────────
export const recentRevealSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  revealType: revealType,
  creditsConsumed: z.number().int().min(0),
  revealedAt: z.string().datetime({ offset: true }),
});
export type RecentReveal = z.infer<typeof recentRevealSchema>;

// ── Hot leads (facets only — no PII; max 5) ────────────────────────────────────────────────────────────
export const hotLeadSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  emailDomain: z.string().nullable(),
  priorityScore: z.number(),
  outreachStatus: z.string(),
  isRevealed: z.boolean(),
});
export type HotLead = z.infer<typeof hotLeadSchema>;

// ── Recent imports ─────────────────────────────────────────────────────────────────────────────────────
export const recentImportSchema = z.object({
  sourceName: z.string(),
  sourceFile: z.string().nullable(),
  contactCount: z.number().int().min(0),
  importedAt: z.string().datetime({ offset: true }),
});
export type RecentImport = z.infer<typeof recentImportSchema>;

// ── Enrichment provider activity ───────────────────────────────────────────────────────────────────────
export const enrichmentActivitySchema = z.object({
  providerName: z.string(),
  status: z.string(),
  cacheHit: z.boolean(),
  calledAt: z.string().datetime({ offset: true }),
});
export type EnrichmentActivity = z.infer<typeof enrichmentActivitySchema>;

// ── Sequence snapshot (aggregate counts) ───────────────────────────────────────────────────────────────
export const sequenceSnapshotSchema = z.object({
  activeSequences: z.number().int().min(0),
  enrolled: z.number().int().min(0),
  sent: z.number().int().min(0),
  replied: z.number().int().min(0),
});
export type SequenceSnapshot = z.infer<typeof sequenceSnapshotSchema>;

// ── Activity feed (minimized audit columns only — no PII; max 15) ──────────────────────────────────────
export const activityFeedItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  occurredAt: z.string().datetime({ offset: true }),
});
export type ActivityFeedItem = z.infer<typeof activityFeedItemSchema>;

// ── Today's tasks (PII-safe: ids + kind + due time only; max 20) ─────────────────────────────────────────
export const homeTaskKind = z.enum(["follow_up", "review_reply", "reveal", "enrich", "custom"]);
export type HomeTaskKind = z.infer<typeof homeTaskKind>;

export const todaysTaskSchema = z.object({
  id: z.string(),
  kind: homeTaskKind,
  contactId: z.string().nullable(),
  dueAt: z.string().datetime({ offset: true }),
});
export type TodaysTask = z.infer<typeof todaysTaskSchema>;

// ── Recent replies (PII-safe: references only — no email address, no message body; max 10) ───────────────
export const recentReplySchema = z.object({
  id: z.string(),
  contactId: z.string(),
  sequenceId: z.string().nullable(),
  channel: z.string(),
  repliedAt: z.string().datetime({ offset: true }),
});
export type RecentReply = z.infer<typeof recentReplySchema>;

// ── The Home dashboard summary (GET /home/summary) ─────────────────────────────────────────────────────
export const homeSummarySchema = z.object({
  creditBalance: z.number().int().min(0),
  burn: z.array(burnPointSchema),
  recentReveals: z.array(recentRevealSchema).max(10),
  hotLeads: z.array(hotLeadSchema).max(5),
  recentImports: z.array(recentImportSchema),
  enrichmentActivity: z.array(enrichmentActivitySchema),
  sequenceSnapshot: sequenceSnapshotSchema,
  activityFeed: z.array(activityFeedItemSchema).max(15),
  todaysTasks: z.array(todaysTaskSchema).max(20),
  recentReplies: z.array(recentReplySchema).max(10),
});
export type HomeSummary = z.infer<typeof homeSummarySchema>;
