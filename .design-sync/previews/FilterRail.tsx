// FilterRail — the MVP client-side faceted rail (05 §5): facet values are derived from the loaded rows
// rather than the search index, and it hosts the AI natural-language box and the workspace tag facets.
import { FilterRail } from "@leadwolf/ui";
import { useState } from "react";
import { CONTACTS, PROSPECT_FILTER, TAGS } from "../prospect/fixtures";
import { Shell } from "./_prospectShell";

const rail: React.CSSProperties = { width: 264, background: "var(--tp-surface)" };

/** Facets active — seniority, email status, department and a tag — with the summary chips above the grid. */
export const Filtered = () => {
  const [filter, setFilter] = useState(PROSPECT_FILTER);
  return (
    <Shell>
      <div style={rail}>
        <FilterRail filter={filter} onChange={setFilter} contacts={CONTACTS} tags={TAGS} />
      </div>
    </Shell>
  );
};

/** Nothing selected — the rail's resting state, with every facet group collapsed to its options. */
export const Unfiltered = () => {
  const [filter, setFilter] = useState({
    ...PROSPECT_FILTER,
    seniority: [],
    emailStatus: [],
    tags: [],
    department: null,
    hasEmail: false,
  });
  return (
    <Shell>
      <div style={rail}>
        <FilterRail filter={filter} onChange={setFilter} contacts={CONTACTS} tags={TAGS} />
      </div>
    </Shell>
  );
};
