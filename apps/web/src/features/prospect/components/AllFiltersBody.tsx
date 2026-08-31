// AllFiltersBody.tsx — the facet controls of ONE opened "All filters" group. Loaded through next/dynamic by
// AllFiltersSection (perf-checklist PA-3): the group headers render eagerly from pure data, but opening a
// group is an intent, and the default visit — the quick tier and the grid — should not pay for controls it
// has not asked for. One module serves every group (the chunk loads once, on the first open).
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { ALL_FILTER_GROUPS } from "../filterGroups";
import { FacetControl, type OwnerOption } from "./FacetControl";

export function AllFiltersBody({
  groupId,
  query,
  onChange,
  counts,
  owners,
}: {
  groupId: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  const group = ALL_FILTER_GROUPS.find((g) => g.id === groupId);
  if (!group) return null;
  return (
    <>
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
    </>
  );
}
