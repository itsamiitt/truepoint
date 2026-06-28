// types.ts — the shapes the Tenants area renders. These mirror the api `/admin/tenants` + `/admin/tenants/:id`
// read payloads (apps/api/src/features/admin, backed by @leadwolf/db platformAdminReads). Presentation-side
// types only; the api owns the canonical shape.

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  seatLimit: number;
  workspaceLimit: number | null;
  revealCreditBalance: number;
  regionDefault: string;
  createdAt: string;
}

export interface TenantWorkspace {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdAt: string;
}

export interface TenantMember {
  userId: string;
  email: string;
  fullName: string | null;
  isTenantOwner: boolean;
  status: string;
}

export interface TenantDetail {
  tenant: TenantRow;
  // The per-tenant P1-01 auth-enforcement master switch (mirrors PlatformTenantDetail.enforcementEnabled).
  // Read-only here; flipped only via the audited, super_admin-gated POST /admin/tenants/:id/auth-enforcement.
  enforcementEnabled: boolean;
  workspaces: TenantWorkspace[];
  members: TenantMember[];
}
