// capability middleware — the server-authoritative capability gate for the dashboard BFF (13 §3, ecosystem
// -facts §C). The console hides nav by capability (UX), but EVERY BFF call re-checks server-side here — the
// console is not a security boundary (13 §Security). SSO maps the data_ops staff role → data:* capabilities;
// super_admin implies all. Real JWT/staff resolution lives in ./auth.ts (@leadwolf/auth); the resolver is injected.
import type { Context, Next } from "hono";

export type Capability = "data:read" | "data:manage" | "data:review" | "data:export";

export interface StaffPrincipal {
  userId: string;
  capabilities: Capability[];
  isSuperAdmin?: boolean;
}

export type ResolveStaff = (c: Context) => StaffPrincipal | null | Promise<StaffPrincipal | null>;

export function hasCapability(p: StaffPrincipal, cap: Capability): boolean {
  return p.isSuperAdmin === true || p.capabilities.includes(cap);
}

/** Gate a BFF route on a `data:*` capability (401 unauthenticated, 403 missing capability). */
export function requireCapability(cap: Capability, resolve: ResolveStaff) {
  return async (c: Context, next: Next) => {
    const principal = await resolve(c);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (!hasCapability(principal, cap)) return c.json({ error: "forbidden", capability: cap }, 403);
    c.set("staff", principal);
    await next();
  };
}
