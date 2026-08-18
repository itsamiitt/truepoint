// navConfig.ts — the SINGLE source of truth for the Forge operator-console navigation (mirrors the apps/admin
// pattern). Add a destination here once and the rail + top-bar title pick it up.
import { type NavDestination, makeSectionTitleResolver } from "@leadwolf/app-shell";
import { Braces, ClipboardCheck, LayoutDashboard, Link2, RefreshCw, ScanLine } from "lucide-react";

// The destination shape + isActive come from @leadwolf/app-shell, shared with apps/web.
export type { NavDestination };
export { isActive } from "@leadwolf/app-shell";

/** The Forge operator-console rail destinations. */
export const DESTINATIONS: NavDestination[] = [
  { label: "Overview", href: "/overview", match: "/overview", icon: LayoutDashboard },
  { label: "Captures", href: "/captures", match: "/captures", icon: ScanLine },
  { label: "Source fetches", href: "/source-fetches", match: "/source-fetches", icon: Link2 },
  { label: "Parsers", href: "/parsers", match: "/parsers", icon: Braces },
  { label: "Review", href: "/review", match: "/review", icon: ClipboardCheck },
  { label: "Sync status", href: "/sync-status", match: "/sync-status", icon: RefreshCw },
];

/** Map a pathname to its top-bar section title (longest match wins). */
export const sectionTitleFor = makeSectionTitleResolver(DESTINATIONS, "Forge");
