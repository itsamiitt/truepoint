// navConfig.ts — the SINGLE source of truth for the Forge operator-console navigation (mirrors the apps/admin
// pattern). Add a destination here once and the rail + top-bar title pick it up.
import type { IconComponent } from "@leadwolf/ui";
import { Braces, ClipboardCheck, LayoutDashboard, RefreshCw, ScanLine } from "lucide-react";

export interface NavDestination {
  label: string;
  href: string;
  /** Path prefix that marks this destination active (nested routes still highlight it). */
  match: string;
  icon: IconComponent;
}

/** The Forge operator-console rail destinations. */
export const DESTINATIONS: NavDestination[] = [
  { label: "Overview", href: "/overview", match: "/overview", icon: LayoutDashboard },
  { label: "Captures", href: "/captures", match: "/captures", icon: ScanLine },
  { label: "Parsers", href: "/parsers", match: "/parsers", icon: Braces },
  { label: "Review", href: "/review", match: "/review", icon: ClipboardCheck },
  { label: "Sync status", href: "/sync-status", match: "/sync-status", icon: RefreshCw },
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
  return "Forge";
}
