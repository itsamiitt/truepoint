// staffCapability.ts — the granular staff permission model (13a F3, ADR-0011 / 13 §2). doc 13 §2 calls for
// per-area+per-action permissions ("tenants:suspend", "credits:grant"); this makes that explicit. The five
// `staffRole`s become capability BUNDLES — a role is checked by the capability it grants, not by a hard-coded
// role list scattered across endpoints. `requireCapability` (apps/api) enforces it; `/admin/me` reports the
// caller's capabilities so the console can hide actions it can't perform (defence-in-depth; the api stays
// authoritative). super_admin implies every capability.

import { type StaffRole, staffRole } from "./auth.ts";

import { z } from "zod";

/** The closed set of staff capabilities (entity:action). Extend as gated actions are added. */
export const staffCapability = z.enum([
  "tenants:suspend", // suspend / reactivate an org
  "tenants:credits", // manual credit grant / adjustment
  "tenants:plan", // apply a plan template (plan / limits / entitlements override)
  "tenants:hold", // place / lift an account (abuse) hold
  "tenants:notes:write", // add a support note
  "users:deactivate", // deactivate / reactivate a global user
  "billing:read", // view billing / revenue economics
  "elevation:request", // mint a JIT elevation
  "audit:read", // read / export the platform audit log
  "compliance:read", // read the cross-tenant compliance/DSAR oversight
  "compliance:manage", // author retention policies / compliance config
  "impersonate:start", // start an impersonation session
  "staff:manage", // grant / revoke staff roles
  "providers:manage", // toggle / budget enrichment providers
  "pricing:manage", // author the credit-pack pricing catalog
  "content:manage", // author announcements / in-app banners
  "flags:manage", // create / toggle feature flags + per-tenant overrides (super_admin-only)
]);
export type StaffCapability = z.infer<typeof staffCapability>;

const ALL_CAPABILITIES: StaffCapability[] = staffCapability.options;

// Per-role capability bundles (13 §2 capability matrix). super_admin is handled separately (implies ALL), so
// it is intentionally absent here. Keep this in sync with the per-endpoint requireCapability gates.
const ROLE_CAPABILITIES: Record<Exclude<StaffRole, "super_admin">, StaffCapability[]> = {
  support: [
    "users:deactivate",
    "tenants:notes:write",
    "tenants:hold",
    "impersonate:start",
    "content:manage",
  ],
  billing_ops: ["tenants:credits", "billing:read", "elevation:request"],
  compliance_officer: ["audit:read", "compliance:read", "compliance:manage"],
  read_only: [],
};

/** Every capability a role holds (super_admin → all). */
export function capabilitiesForRole(role: StaffRole): StaffCapability[] {
  return role === "super_admin" ? [...ALL_CAPABILITIES] : [...(ROLE_CAPABILITIES[role] ?? [])];
}

/** Whether a role grants a specific capability (super_admin → always). */
export function roleHasCapability(role: StaffRole, cap: StaffCapability): boolean {
  return role === "super_admin" || (ROLE_CAPABILITIES[role]?.includes(cap) ?? false);
}

/** What `/admin/me` returns — the caller's staff role + the capabilities it grants (for the console to gate UI). */
export const staffMeSchema = z.object({
  staffRole: staffRole.nullable(),
  capabilities: z.array(staffCapability),
});
export type StaffMe = z.infer<typeof staffMeSchema>;
