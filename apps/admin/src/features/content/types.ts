// types.ts — the shape the Content (announcements) area renders. Mirrors the api `/admin/announcements`
// payload (apps/api/src/features/admin/announcements.ts, backed by @leadwolf/db announcementRepository).
// Presentation-side type only; the api owns the canonical shape.

export interface Announcement {
  id: string;
  title: string;
  body: string;
  level: string;
  audience: string;
  tenantTarget: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
