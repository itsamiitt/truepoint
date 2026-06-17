// types.ts — view shapes for the Tenant ▸ Organization scope (12 §4): the organization identity (name, logo,
// default region), the tenant's workspaces, and a members-directory summary. These follow the documented
// /settings/tenant + /tenants/me + /workspaces contracts (09 §3.1); where a route isn't built the api layer
// reports it (null / available:false) and the panels degrade to disabled/empty states rather than inventing
// data. The region vocabulary mirrors the Workspace scope so the two settings surfaces read consistently.

/** Data-residency regions (12 §4 default region). Mirrors the Workspace scope's list so the two stay aligned. */
export const REGIONS = [
  { value: "us", label: "United States (us-east-1)" },
  { value: "eu", label: "European Union (eu-west-1)" },
  { value: "ap", label: "Asia Pacific (ap-southeast-1)" },
];

/** GET /settings/tenant — the organization identity card (12 §4: tenant name, logo, default region — M1). */
export interface Organization {
  name: string;
  /** Logo URL; null/empty ⇒ no logo set (we show grey initials). */
  logoUrl?: string | null;
  /** Default data-residency region key (matches REGIONS values). */
  region: string;
}

/** A workspace under this tenant (GET /workspaces — create/archive, 12 §4 Workspaces · M2). */
export interface TenantWorkspace {
  id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  /** Members in this workspace; undefined when the count isn't returned. */
  memberCount?: number;
}

/** `available` is false when the /workspaces route isn't built yet. */
export interface WorkspacesFeed {
  available: boolean;
  workspaces: TenantWorkspace[];
}

/** A tenant-wide member (GET /settings/tenant/members — directory summary, 12 §4 · M2). */
export type TenantOrgRole = "owner" | "billing_admin" | "security_admin" | "compliance_admin" | "member";

export interface TenantMember {
  id: string;
  email: string;
  name?: string | null;
  orgRole: TenantOrgRole;
  status: "active" | "invited" | "deactivated";
}

/** Members-directory summary: a small headline (counts) + a few sample rows. `available` gates the unbuilt API. */
export interface MembersSummary {
  available: boolean;
  total: number;
  activeCount: number;
  invitedCount: number;
  /** A short sample of members for the directory preview (full directory lives in Workspace ▸ Members). */
  sample: TenantMember[];
}

export const WORKSPACE_STATUS_TONE = {
  active: "success",
  archived: "muted",
} as const;

export const ORG_ROLE_LABEL: Record<TenantOrgRole, string> = {
  owner: "Owner",
  billing_admin: "Billing admin",
  security_admin: "Security admin",
  compliance_admin: "Compliance admin",
  member: "Member",
};

export const MEMBER_STATUS_TONE = {
  active: "success",
  invited: "warning",
  deactivated: "muted",
} as const;
