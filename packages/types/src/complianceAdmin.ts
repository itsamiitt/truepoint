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
