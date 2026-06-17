// types.ts — view shapes for the Billing & Credits surface (12 §4). The usage-history row is the documented
// /credits/usage contract, so it re-exports from @leadwolf/types (single source of truth, packages/types/src/
// billing.ts). The plan envelope follows GET /tenants/me (09 §3.1); when that route isn't built the api layer
// reports it (null) and the page degrades to disabled/empty states rather than inventing a plan.

import type { RevealType, UsageReveal } from "@leadwolf/types";

export type { RevealType, UsageReveal };

/** GET /tenants/me — the tenant's plan tier, seat usage, workspace limit, and credit balance (09 §3.1). */
export interface TenantPlan {
  /** Plan tier key — e.g. "free" | "starter" | "team" | "enterprise" (12 §6). */
  tier: string;
  /** Seats currently consumed (active tenant members). */
  seatsUsed?: number;
  /** Seat ceiling for the plan; null/undefined ⇒ unlimited. */
  seatLimit?: number | null;
  /** Workspaces currently created. */
  workspacesUsed?: number;
  /** Workspace ceiling for the plan; null/undefined ⇒ unlimited. */
  workspaceLimit?: number | null;
  /** Credit-pool balance (mirrors /credits/balance; present on the envelope per 09 §3.1). */
  balance?: number;
}

export const TIER_LABEL: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

export const REVEAL_LABEL: Record<RevealType, string> = {
  email: "Email",
  phone: "Phone",
  full_profile: "Full profile",
};

/** Render a "used / limit" string, treating a null/undefined limit as unlimited (∞). */
export function formatQuota(used: number | undefined, limit: number | null | undefined): string {
  const u = used ?? 0;
  if (limit == null) return `${u.toLocaleString()} · no limit`;
  return `${u.toLocaleString()} / ${limit.toLocaleString()}`;
}
