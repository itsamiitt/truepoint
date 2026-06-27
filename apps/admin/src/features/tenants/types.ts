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
  workspaces: TenantWorkspace[];
  members: TenantMember[];
}

/** A staff support note about a tenant (13a Area 3). Mirrors the api `/admin/tenants/:id/notes` shape. */
export interface SupportNote {
  id: string;
  tenantId: string;
  staffUserId: string;
  body: string;
  ticketUrl: string | null;
  createdAt: string;
}

/** The customer-360 usage/health overview of a tenant (13a Area 3). Mirrors `/admin/tenants/:id/overview`. */
export interface TenantOverview {
  reveals30d: number;
  burn30d: number;
  revealsTotal: number;
  lastRevealAt: string | null;
  activeHolds: number;
}

/** A credit-pack purchase by a tenant (13a Area 4). Mirrors `/admin/tenants/:id/purchases`. */
export interface Purchase {
  id: string;
  credits: number;
  amountCents: number | null;
  status: string;
  createdAt: string;
}

/** An abuse / fraud hold on a tenant (13a Area 7). Mirrors the api `/admin/tenants/:id/holds` shape. */
export interface AccountHold {
  id: string;
  tenantId: string;
  kind: string;
  reason: string;
  placedByUserId: string;
  placedAt: string;
  liftedAt: string | null;
  liftedByUserId: string | null;
}
