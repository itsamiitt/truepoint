// AllFiltersSection.tsx — the second tier of the rail, Search v4 shape: a plain "All filters" heading with
// every one-side-only GROUP listed under it as a closed accordion (no collapsible tier wrapper any more —
// the group headers are cheap pure data, so hiding them bought nothing but a click). Groups that search the
// TruePoint database instead of saved contacts are tagged "Database only" (the saved-contacts side is the
// default and carries no tag), and a scope that already rules a side out hides those groups with a one-line
// note rather than offering controls that would silently do nothing.
//
// The group HEADERS are eager; a group's BODY (the facet controls) is next/dynamic — opening a group is an
// intent (perf-checklist PA-3), and /search has a 200kB First Load budget the quick tier + grid must fit
// inside. One module serves every group, so the chunk is fetched once on the first open.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import dynamic from "next/dynamic";
import { ALL_FILTER_GROUPS, type FilterGroup, groupActiveCount } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import { AccordionGroup } from "./AccordionGroup";
import type { OwnerOption } from "./FacetControl";

const AllFiltersBody = dynamic(() => import("./AllFiltersBody").then((m) => m.AllFiltersBody), {
  ssr: false,
  loading: () => <p className={styles.tierNote}>Loading filters…</p>,
});

// Only the database side gets a tag — "Workspace only" labels were removed from every filter option
// (2026-08-31): the default side needs no mark, and the notice above the grid still explains a narrowing.
const TAG: Record<string, string> = {
  "database-only": "Database only",
};

/**
 * Which groups can apply under the current scope. "Not saved" has no saved contacts to narrow, so the
 * workspace-only groups go; "Saved" cannot be searched by a database-only facet (it skips the saved half),
 * so the Background group goes. "All" offers everything.
 */
function applicable(group: FilterGroup, scope: WorkspaceScope): boolean {
  if (scope === "exclude") return group.scope === "database-only";
  if (scope === "mine") return group.scope !== "database-only";
  return true;
}

export function AllFiltersSection({
  query,
  onChange,
  counts,
  owners,
  scope,
}: {
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
  scope: WorkspaceScope;
}) {
  const groups = useOpenGroups();
  const shown = ALL_FILTER_GROUPS.filter((g) => applicable(g, scope));

  return (
    <section className={styles.railSec}>
      <h3 className={styles.railSecTitle}>All filters</h3>
      {scope !== "all" ? (
        <p className={styles.tierNote}>
          {scope === "exclude"
            ? "Filters on your saved contacts don't apply to people you haven't saved yet — switch to All or Saved to use them."
            : "Database-only filters don't apply to saved contacts — switch to All or Not saved to use them."}
        </p>
      ) : null}
      {shown.map((group) => (
        <AccordionGroup
          key={group.id}
          id={`search-group-${group.id}`}
          title={group.title}
          tag={group.scope ? TAG[group.scope] : undefined}
          open={groups.isOpen(group.id)}
          onToggle={() => groups.toggle(group.id)}
          badge={
            groupActiveCount(
              query,
              group.facets.map((f) => f.field),
            ) || undefined
          }
        >
          <AllFiltersBody
            groupId={group.id}
            query={query}
            onChange={onChange}
            counts={counts}
            owners={owners}
          />
        </AccordionGroup>
      ))}
    </section>
  );
}
