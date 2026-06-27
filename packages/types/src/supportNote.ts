// supportNote.ts — staff support-notes contract (13a Area 3, 13 §3.3). Internal notes a staff operator keeps
// against a tenant during support (with an optional ticket link), surfaced on the tenant detail. Staff-only
// data (never shown to the customer); the body is free text, the ticket link is validated as a URL. Shared by
// apps/api (validates the create) and apps/admin (derives its view type).

import { z } from "zod";

/** Add a note to a tenant. `body` is required free text; `ticketUrl` is an optional link to the support ticket. */
export const createSupportNoteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  ticketUrl: z.string().url().max(500).optional(),
});
export type CreateSupportNoteInput = z.infer<typeof createSupportNoteSchema>;

/** A support note as shown in the console (newest first). */
export const supportNoteViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  staffUserId: z.string().uuid(),
  body: z.string(),
  ticketUrl: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
});
export type SupportNoteView = z.infer<typeof supportNoteViewSchema>;
