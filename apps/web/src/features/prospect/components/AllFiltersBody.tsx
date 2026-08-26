// AllFiltersBody.tsx — the OPENED "All filters" tier: the saved-contacts-only groups as accordions. Loaded
// through next/dynamic by AllFiltersSection (perf-checklist PA-3): opening the tier is an intent, and the
// default visit — the quick tier and the grid — should not pay for the five groups it has not asked for.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { ALL_FILTER_GROUPS, groupActiveCount } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import { AccordionGroup } from "./AccordionGroup";
import { FacetControl, type OwnerOption } from "./FacetControl";

export function AllFiltersBody({
  query,
  onChange,
  counts,
  owners,
}: {
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  const groups = useOpenGroups();
  return (
    <>
      <p className={styles.tierNote}>
        These narrow the list to contacts already saved in your workspace.
      </p>
      {ALL_FILTER_GROUPS.map((group) => (
        <AccordionGroup
          key={group.id}
          id={`search-group-${group.id}`}
          title={group.title}
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
