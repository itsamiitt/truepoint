// navConfig.ts — the SINGLE source of truth for app navigation. Replaces the three hard-coded copies that used
// to live in Sidebar.tsx, AppShell.tsx and CommandPalette.tsx — add a destination in exactly one place and the
// rail, top-bar title, command palette, and settings scope-nav all pick it up.
import type { IconComponent } from "@leadwolf/ui";
import { BarChart2, Home, Inbox, Search, Send, Settings } from "lucide-react";

export interface NavDestination {
  label: string;
  href: string;
  /** Path prefix that marks this destination active (nested routes still highlight it). */
  match: string;
  icon: IconComponent;
}

/** The primary rail destinations (11 §2). Inbox is a real destination now (was a placeholder page). */
export const DESTINATIONS: NavDestination[] = [
  { label: "Home", href: "/home", match: "/home", icon: Home },
  { label: "Prospect", href: "/prospect", match: "/prospect", icon: Search },
  { label: "Sequences", href: "/sequences", match: "/sequences", icon: Send },
  { label: "Inbox", href: "/inbox", match: "/inbox", icon: Inbox },
  { label: "Reports", href: "/reports", match: "/reports", icon: BarChart2 },
];

/** Pinned Settings entry in the rail. Points at an existing route; the scope sub-nav lives in the settings
 *  layout (driven by SETTINGS_NAV below). */
export const SETTINGS_DESTINATION: NavDestination = {
  label: "Settings",
  href: "/settings/profile",
  match: "/settings",
  icon: Settings,
};

export interface SettingsNavItem {
  label: string;
  href: string;
  match: string;
}
export interface SettingsNavGroup {
  /** Scope heading (User · Workspace · Tenant · Developer — 12 §1). */
  scope: string;
  items: SettingsNavItem[];
}

/** The four settings scopes (12 §1) — the canonical map. Unit 0 ships a placeholder page for every route here so
 *  nothing 404s; each S-unit replaces its placeholder with the real page. Keep this list in sync when adding a
 *  settings route (it's the one place the scope nav reads). */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    scope: "User",
    items: [
      { label: "Profile", href: "/settings/profile", match: "/settings/profile" },
      { label: "Security", href: "/settings/security", match: "/settings/security" },
      { label: "Notifications", href: "/settings/notifications", match: "/settings/notifications" },
    ],
  },
  {
    scope: "Workspace",
    items: [
      { label: "General", href: "/settings/workspace", match: "/settings/workspace" },
      { label: "Members", href: "/settings/members", match: "/settings/members" },
      { label: "Suppression & DSAR", href: "/settings/compliance", match: "/settings/compliance" },
    ],
  },
  {
    scope: "Tenant",
    items: [
      { label: "Billing & credits", href: "/settings/billing", match: "/settings/billing" },
      { label: "Organization", href: "/settings/organization", match: "/settings/organization" },
    ],
  },
  {
    scope: "Developer",
    items: [{ label: "API keys", href: "/settings/api-keys", match: "/settings/api-keys" }],
  },
];

/** Map a pathname to its top-bar section title. */
export function sectionTitleFor(pathname: string): string {
  if (pathname.startsWith("/settings")) return "Settings";
  for (const d of DESTINATIONS) {
    if (pathname === d.match || pathname.startsWith(`${d.match}/`)) return d.label;
  }
  if (pathname.startsWith("/import")) return "Import";
  if (pathname.startsWith("/enrichment/jobs")) return "Enrichment jobs";
  return "TruePoint";
}

/** Whether `pathname` is at or under a `match` prefix. */
export function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

export interface PaletteEntry {
  id: string;
  label: string;
  href: string;
  keywords?: string[];
}

export const PALETTE_NAVIGATE: PaletteEntry[] = [
  ...DESTINATIONS.map<PaletteEntry>((d) => ({
    id: `nav-${d.match}`,
    label: d.label,
    href: d.href,
  })),
  {
    id: "nav-settings",
    label: "Settings",
    href: SETTINGS_DESTINATION.href,
    keywords: ["preferences"],
  },
];

export const PALETTE_QUICK: PaletteEntry[] = [
  { id: "act-search", label: "New search", href: "/prospect", keywords: ["prospect", "find"] },
  { id: "act-import", label: "Import contacts", href: "/import", keywords: ["csv", "upload"] },
  {
    id: "act-enrichment-jobs",
    label: "Enrichment jobs",
    href: "/enrichment/jobs",
    keywords: ["enrich", "bulk", "status", "job", "progress"],
  },
  {
    id: "act-topup",
    label: "Top up credits",
    href: "/settings/billing",
    keywords: ["billing", "buy", "balance"],
  },
];
