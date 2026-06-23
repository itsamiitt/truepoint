// types.ts — the shapes the Staff RBAC area renders. These mirror the api `/admin/staff` read payload + the
// grant body (apps/api/src/features/admin/staff.ts, backed by @leadwolf/db staffRepository). The canonical
// shapes are the shared Zod schemas in @leadwolf/types (staffMemberViewSchema / grantStaffSchema); these are
// the presentation-side mirrors. The staff-role vocabulary is the single source of truth on the api.

export type StaffRole =
  | "super_admin"
  | "support"
  | "billing_ops"
  | "compliance_officer"
  | "read_only";

/** The selectable staff roles + a human label (the grant form's options). */
export const STAFF_ROLE_OPTIONS: ReadonlyArray<{ value: StaffRole; label: string }> = [
  { value: "super_admin", label: "Super admin" },
  { value: "support", label: "Support" },
  { value: "billing_ops", label: "Billing ops" },
  { value: "compliance_officer", label: "Compliance officer" },
  { value: "read_only", label: "Read only" },
];

export interface StaffMember {
  userId: string;
  email: string;
  fullName: string | null;
  staffRole: StaffRole;
  status: string; // active|revoked
  grantedAt: string; // ISO-8601
}
