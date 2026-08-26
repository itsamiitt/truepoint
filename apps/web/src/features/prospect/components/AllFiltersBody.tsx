// AllFiltersBody.tsx — the OPENED "All filters" tier: the one-side-only groups as accordions, each tagged
// with the side it searches. Loaded through next/dynamic by AllFiltersSection (perf-checklist PA-3):
// opening the tier is an intent, and the default visit — the quick tier and the grid — should not pay for
// the six groups it has not asked for.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import { ALL_FILTER_GROUPS, type FilterGroup, groupActiveCount } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import { AccordionGroup } from "./AccordionGroup";
import { FacetControl, type OwnerOption } from "./FacetControl";

const TAG: Record<string, string> = {
  "workspace-only": "Workspace only",
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

export function AllFiltersBody({
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
    <>
      <p className={styles.tierNote}>
        {scope === "exclude"
          ? "Workspace-only filters don't apply to people you haven't saved yet — switch to All or Saved to use them."
          : scope === "mine"
            ? "Database-only filters don't apply to saved contacts — switch to All or Not saved to use them."
            : "Each group searches one side: Workspace only narrows to your saved contacts; Database only searches the TruePoint database instead."}
      </p>
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
          {group.facets.map((facet) => (
            <FacetControl
              key={`${facet.kind}:${facet.field}`}
              facet={facet}
              query={query}
              onChange={onChange}
              counts={counts}
              owners={owners}
            />
          ))}
        </AccordionGroup>
      ))}
    </>
  );
}
