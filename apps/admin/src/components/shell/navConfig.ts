// navConfig.ts — the SINGLE source of truth for the staff-console navigation (mirrors the apps/web pattern).
// The console areas come from 13 §3; this phase ships Tenants + System health, with the remaining areas
// (Users, Billing, Compliance, …) added by sibling units as their own feature folders. Add a destination
// here once and the rail + top-bar title pick it up.
import type { IconComponent } from "@leadwolf/ui";
import {
  Activity,
  Building2,
  Flag,
  Layers,
  Plug,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Users,
  Wallet,
} from "lucide-react";

export interface NavDestination {
  label: string;
  href: string;
  /** Path prefix that marks this destination active (nested routes still highlight it). */
  match: string;
  icon: IconComponent;
}

/** The staff-console rail destinations shipped in this phase (13 §3.1 + §9). */
export const DESTINATIONS: NavDestination[] = [
  { label: "Tenants", href: "/tenants", match: "/tenants", icon: Building2 },
  { label: "Users", href: "/users", match: "/users", icon: Users },
  { label: "Billing", href: "/billing", match: "/billing", icon: Wallet },
  { label: "Plans", href: "/plans", match: "/plans", icon: Layers },
  { label: "Pricing", href: "/pricing", match: "/pricing", icon: Tag },
  { label: "Providers", href: "/provider-configs", match: "/provider-configs", icon: Plug },
  { label: "Feature flags", href: "/feature-flags", match: "/feature-flags", icon: Flag },
  { label: "Staff", href: "/staff", match: "/staff", icon: ShieldCheck },
  { label: "Compliance", href: "/compliance", match: "/compliance", icon: ShieldAlert },
  { label: "Audit log", href: "/audit-log", match: "/audit-log", icon: ScrollText },
  { label: "System health", href: "/system-health", match: "/system-health", icon: Activity },
];

/** Whether `pathname` is at or under a `match` prefix. */
export function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

/** Map a pathname to its top-bar section title. */
export function sectionTitleFor(pathname: string): string {
  for (const d of DESTINATIONS) {
    if (isActive(pathname, d.match)) return d.label;
  }
  return "Platform admin";
}
