// sidebarEntries.ts — what the documentation rail lists, in three groups.
//
// Derived from the same content modules the pages render from, so adding a guide or an endpoint gives it
// navigation in the commit that gives it a route. Separated from the component because the rail is now a
// client component (it holds filter state) and this list is plain data the server can hand it — keeping the
// derivation here means the content modules are not dragged into the client chunk twice.

import { ENDPOINTS } from "@/content/endpoints/index.ts";
import { GUIDES } from "@/content/guides/index.ts";

export interface SidebarEntry {
  readonly href: string;
  readonly label: string;
  /** The HTTP verb, for endpoint entries only. Rendered as the word, never as colour alone. */
  readonly method?: "GET" | "POST";
}

export interface SidebarGroup {
  readonly heading: string;
  readonly entries: readonly SidebarEntry[];
}

/** The two pages that ARE a tool rather than a document — a console and a generated artifact — so neither has
 *  a content module to be derived from. The design groups them above the prose, because a reader who wants to
 *  try a call should not have to scroll past six guides to find where. */
const TOOLS: readonly SidebarEntry[] = [
  { href: "/docs/playground", label: "API playground" },
  { href: "/docs/machine-reference", label: "Machine reference" },
];

const GUIDE_ENTRIES: readonly SidebarEntry[] = [
  { href: "/docs", label: "Quickstart" },
  ...GUIDES.map((guide) => ({ href: `/docs/${guide.slug}`, label: guide.title })),
];

const ENDPOINT_ENTRIES: readonly SidebarEntry[] = ENDPOINTS.map((endpoint) => ({
  href: `/docs/api/${endpoint.slug}`,
  label: endpoint.title,
  method: endpoint.method,
}));

export const SIDEBAR_GROUPS: readonly SidebarGroup[] = [
  { heading: "Tools", entries: TOOLS },
  { heading: "Guides", entries: GUIDE_ENTRIES },
  { heading: "API reference", entries: ENDPOINT_ENTRIES },
];

/** Filter the groups by a free-text query, dropping any group left empty.
 *
 * Matches the method too, so typing "post" narrows the reference to the endpoints that take a body — the one
 * query a reader types where the label alone would return nothing. */
export function filterGroups(query: string): readonly SidebarGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SIDEBAR_GROUPS;

  return SIDEBAR_GROUPS.map((group) => ({
    heading: group.heading,
    entries: group.entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) ||
        (entry.method?.toLowerCase().includes(needle) ?? false),
    ),
  })).filter((group) => group.entries.length > 0);
}
