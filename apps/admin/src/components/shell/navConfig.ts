// navConfig.ts — the SINGLE source of truth for the staff-console navigation (mirrors the apps/web pattern).
// The console areas come from 13 §3; this phase ships Tenants + System health, with the remaining areas
// (Users, Billing, Compliance, …) added by sibling units as their own feature folders. Add a destination
// here once and the rail + top-bar title pick it up.
import type { IconComponent } from "@leadwolf/ui";
import {
  Activity,
  Building2,
  Database,
  FileUp,
  Flag,
  Gauge,
  KeyRound,
  Layers,
  Megaphone,
  Plug,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Sparkles,
  Tag,
  Timer,
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
  { label: "Content", href: "/content", match: "/content", icon: Megaphone },
  { label: "Retention", href: "/retention", match: "/retention", icon: Timer },
  { label: "Staff", href: "/staff", match: "/staff", icon: ShieldCheck },
  { label: "Auth policy", href: "/auth-policy", match: "/auth-policy", icon: KeyRound },
  { label: "Compliance", href: "/compliance", match: "/compliance", icon: ShieldAlert },
  { label: "Audit log", href: "/audit-log", match: "/audit-log", icon: ScrollText },
  // Data-management control panel (database-management-research Phase 1) — the cross-tenant data-ops overview.
  // A single destination today; later phases expand it into a group (Imports / Validation / Dedup / …).
  { label: "Data management", href: "/data-ops", match: "/data-ops", icon: Database },
  { label: "Bulk imports", href: "/imports", match: "/imports", icon: FileUp },
  { label: "Data quality", href: "/data-quality", match: "/data-quality", icon: Gauge },
  { label: "Trust & abuse", href: "/trust-abuse", match: "/trust-abuse", icon: Siren },
  { label: "AI usage", href: "/ai-usage", match: "/ai-usage", icon: Sparkles },
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
