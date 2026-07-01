// notifications.ts — contracts for the in-app notification feed (G-NTF-1). The feed row + the closed event
// vocabulary + the keyset page (feed + unread count in one fetch for the bell). Title/body are system/staff-
// authored copy (not raw PII); the optional entity link lets a row deep-link. Shared by apps/api (validates)
// and apps/web (derives the bell + feed view types).

import { z } from "zod";

/** The closed notification event vocabulary (mirrored as a varchar in the DB for forward-compat). */
export const notificationType = z.enum([
  "reply_received",
  "low_credits",
  "import_complete",
  "dsar_update",
  "system",
]);
export type NotificationType = z.infer<typeof notificationType>;

/** One notification as shown in the in-app feed. */
export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationType,
  title: z.string(),
  body: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().uuid().nullable(),
  readAt: z.string().datetime({ offset: true }).nullable(), // null = unread
  createdAt: z.string().datetime({ offset: true }),
});
export type Notification = z.infer<typeof notificationSchema>;

/** A keyset page of the caller's feed plus the live unread count (one fetch backs the bell dropdown). */
export const notificationsPageSchema = z.object({
  notifications: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int(),
});
export type NotificationsPage = z.infer<typeof notificationsPageSchema>;
