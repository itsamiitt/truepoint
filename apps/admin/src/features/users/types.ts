// types.ts — the shape the global Users area renders. Mirrors the api `/admin/users` read payload
// (apps/api/src/features/admin/routes.ts → platformAdminRepository.listUsers, backed by @leadwolf/db
// platformAdminReads PlatformUserRow). Presentation-side type only; the api owns the canonical shape.

export interface PlatformUser {
  id: string;
  email: string;
  fullName: string | null;
  status: string;
  isPlatformAdmin: boolean;
}
