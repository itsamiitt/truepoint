// announcementAdmin.ts — platform-admin announcements / in-app banners (13a Area 10, 13 §3.10). Staff author
// announcements; customers see the active ones applicable to their org as a banner. Authoring is platform-
// owned (staff write); the customer read is a filtered, server-scoped projection (active + applicable, no
// authoring metadata). Shared by apps/api (validates), apps/admin (authoring view) and apps/web (banner view).

import { z } from "zod";

export const announcementLevel = z.enum(["info", "warning", "critical"]);
export type AnnouncementLevel = z.infer<typeof announcementLevel>;

/** all = every tenant; tenant = one targeted org (tenantTarget required). */
export const announcementAudience = z.enum(["all", "tenant"]);
export type AnnouncementAudience = z.infer<typeof announcementAudience>;

/** general = a normal banner; maintenance = a site-wide critical, non-dismissible maintenance notice (P4). */
export const announcementType = z.enum(["general", "maintenance"]);
export type AnnouncementType = z.infer<typeof announcementType>;

/** Create or update an announcement. `startsAt`/`endsAt` bound the display window (null = open-ended). The
 *  audience ↔ tenantTarget coherence is enforced: an `all` announcement must omit a target; a `tenant` one
 *  must name it. */
export const announcementUpsertSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    level: announcementLevel,
    type: announcementType.default("general"),
    audience: announcementAudience,
    tenantTarget: z.string().uuid().nullable().default(null),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime().nullable().default(null),
  })
  .refine((v) => (v.audience === "all" ? v.tenantTarget == null : v.tenantTarget != null), {
    message: "audience 'tenant' requires a tenantTarget; audience 'all' must omit it",
    path: ["tenantTarget"],
  });
export type AnnouncementUpsertInput = z.infer<typeof announcementUpsertSchema>;

/** Toggle an announcement on/off (a retired announcement stays for history). */
export const announcementSetActiveSchema = z.object({ active: z.boolean() });
export type AnnouncementSetActiveInput = z.infer<typeof announcementSetActiveSchema>;

/** An announcement as shown in the staff authoring console. */
export const announcementViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  level: announcementLevel,
  type: announcementType,
  audience: announcementAudience,
  tenantTarget: z.string().uuid().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AnnouncementView = z.infer<typeof announcementViewSchema>;

/** The customer-facing projection — an active announcement for the banner (no authoring metadata). */
export const activeAnnouncementSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  level: announcementLevel,
  type: announcementType,
});
export type ActiveAnnouncement = z.infer<typeof activeAnnouncementSchema>;
