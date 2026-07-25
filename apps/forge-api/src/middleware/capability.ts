// capability middleware — the server-authoritative capability gate for the dashboard BFF (13 §3, ecosystem
// -facts §C). The console hides nav by capability (UX), but EVERY BFF call re-checks server-side here — the
// console is not a security boundary (13 §Security). SSO maps the data_ops staff role → data:* capabilities;
// super_admin implies all. Real JWT/staff resolution lives in ./auth.ts (@leadwolf/auth); the resolver is injected.
import type { Context } from "hono";

export type Capability = "data:read" | "data:manage" | "data:review" | "data:export";

export interface StaffPrincipal {
  userId: string;
  capabilities: Capability[];
  /** The active platform-staff role name (e.g. "data_ops") — surfaced by /bff/me for the console rail. */
  staffRole?: string;
  isSuperAdmin?: boolean;
}

export type ResolveStaff = (c: Context) => StaffPrincipal | null | Promise<StaffPrincipal | null>;

export function hasCapability(p: StaffPrincipal, cap: Capability): boolean {
  return p.isSuperAdmin === true || p.capabilities.includes(cap);
}
