// complianceAdmin.ts — platform-admin compliance-ops contracts (13a Area 8, 13 §3.8). The DSAR oversight the
// compliance officer needs: the request queue, by status. DSAR requests are GLOBAL by design (a data subject
// spans all tenants; the find-everywhere blind index, not a tenant_id, is the key), so this is a platform
// queue, not a per-tenant one. PRIVACY-PRESERVING — the subject email is encrypted at rest and is NEVER
// projected here; the oversight surfaces only the request envelope (type, state, timestamps). Shared by
// apps/api (validates the query) and apps/admin (derives its view type). Read-only.

import { z } from "zod";

/** The DSAR lifecycle states (mirrors the dsar_requests status CHECK in schema/compliance.ts). */
export const dsarStatus = z.enum(["received", "verifying", "processing", "completed", "rejected"]);
export type DsarStatus = z.infer<typeof dsarStatus>;

/** The DSAR request kinds (08 §4). */
export const dsarRequestType = z.enum(["access", "delete", "rectify"]);
export type DsarRequestType = z.infer<typeof dsarRequestType>;

/** Filter the cross-tenant DSAR queue. `status` optional; `limit` bounded. */
export const platformDsarQuerySchema = z.object({
  status: dsarStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type PlatformDsarQuery = z.infer<typeof platformDsarQuerySchema>;

// ── Global suppression (blocklist) (13a Area 8 / 13 §3.7) ────────────────────────────────────────────────

/** Add a GLOBAL domain to the suppression/blocklist — blocks reveals + sends for that domain platform-wide
 *  (the existing suppression gate honors global scope). Domain-level only here; email-level global suppression
 *  (which requires the blind-index/HMAC path) is a separate slice. */
export const addGlobalSuppressionSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9.-]+$/, "a bare domain like example.com"),
  reason: z.string().trim().max(500).optional(),
});
export type AddGlobalSuppressionInput = z.infer<typeof addGlobalSuppressionSchema>;

/** A global suppression entry as shown in the console (blind-index columns are never projected — PII). */
export const globalSuppressionViewSchema = z.object({
  id: z.string().uuid(),
  matchType: z.string(),
  domain: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
});
export type GlobalSuppressionView = z.infer<typeof globalSuppressionViewSchema>;

/** One DSAR request as surfaced to staff — the envelope only (never the encrypted subject email). */
export const dsarOversightRowSchema = z.object({
  id: z.string().uuid(),
  requestType: dsarRequestType,
  status: dsarStatus,
  requestedAt: z.string(), // ISO-8601
  verifiedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type DsarOversightRow = z.infer<typeof dsarOversightRowSchema>;

/** The staff-drivable DSAR transitions (08 §4). 'completed' is DELIBERATELY excluded — completion is recorded
 *  by the actual erasure/export fulfilment, never hand-set (a manual 'completed' with no fulfilment would be a
 *  compliance violation); 'received' is the intake state. Rejecting requires a reason. */
export const dsarTransitionSchema = z
  .object({
    status: z.enum(["verifying", "processing", "rejected"]),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.status !== "rejected" || (!!v.reason && v.reason.length >= 3), {
    message: "A rejection needs a reason (min 3 characters).",
    path: ["reason"],
  });
export type DsarTransition = z.infer<typeof dsarTransitionSchema>;

// ── Sub-processor registry (13a Area 8 / GDPR Art. 28) ─────────────────────────────────────────────────────

/** Create / update a sub-processor disclosure entry — name, purpose, processing location, and an optional DPA
 *  link (when present it must be an http(s) URL, validated here so a `javascript:`/garbage link can never reach
 *  the row that the public Trust Center would later render). */
export const subProcessorUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(500),
  location: z.string().trim().min(1).max(120),
  dpaUrl: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https?:\/\/\S+$/, "a DPA link must be an http(s) URL")
    .optional()
    .or(z.literal("")),
  sortOrder: z.coerce.number().int().min(0).max(100000).default(0),
});
export type SubProcessorUpsertInput = z.infer<typeof subProcessorUpsertSchema>;

/** Toggle a sub-processor's published state (remove from / restore to the registry). */
export const subProcessorSetActiveSchema = z.object({ active: z.boolean() });
export type SubProcessorSetActiveInput = z.infer<typeof subProcessorSetActiveSchema>;

/** A sub-processor as shown in the console (and, later, the public Trust Center). */
export const subProcessorViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  purpose: z.string(),
  location: z.string(),
  dpaUrl: z.string().nullable(),
  active: z.boolean(),
  sortOrder: z.number(),
  updatedAt: z.string(), // ISO-8601
});
export type SubProcessorView = z.infer<typeof subProcessorViewSchema>;
