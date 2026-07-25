// nav.ts — the navigation contract every app shell shares. Each app owns its OWN destination list (web's
// customer destinations, admin's staff areas, forge's operator surfaces) but they all describe them with the
// same shape, so one Sidebar, one section-title resolver, and one command palette serve all three.
import type { IconComponent } from "@leadwolf/ui";

export interface NavDestination {
  label: string;
  href: string;
  /** Path prefix that marks this destination active (nested routes still highlight it). */
  match: string;
  icon: IconComponent;
}

/** A command-palette row. `keywords` widen the fuzzy match beyond the visible label. */
export interface PaletteEntry {
  id: string;
  label: string;
  href: string;
  keywords?: string[];
}

/** True when `pathname` sits on `match` or any route nested under it. */
export function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

/**
 * Builds the resolver the top bar uses for its title. Longest match wins, so a nested destination
 * (`/data-ops/dedup`) beats its parent section (`/data-ops`) regardless of list order.
 */
export function makeSectionTitleResolver(
  destinations: NavDestination[],
  fallback: string,
): (pathname: string) => string {
  const byLength = [...destinations].sort((a, b) => b.match.length - a.match.length);
  return (pathname: string) => byLength.find((d) => isActive(pathname, d.match))?.label ?? fallback;
}

/** Derives palette rows from the destination list so a new destination shows up in ⌘K for free. */
export function paletteEntriesFrom(destinations: NavDestination[]): PaletteEntry[] {
  return destinations.map((d) => ({ id: d.href, label: d.label, href: d.href }));
}
