// FilterPanel — the server-driven faceted sidebar (24, ADR-0035). Presentation only: the page owns query
// state, URL persistence, and the live counts. Stateful here so the card is actually operable — toggling a
// facet re-renders the panel exactly as it does in the app.
//
// The groups are collapsed-by-default accordions with no open prop, so both cells force them open on mount
// (see useExpandGroups) — otherwise the card is five headers and no facets.
import { FilterPanel } from "@leadwolf/ui";
import { useState } from "react";
import { CONTACT_QUERY, FACET_COUNTS, OWNERS } from "../prospect/fixtures";
import { Shell, useExpandGroups } from "./_prospectShell";

const rail: React.CSSProperties = { width: 264, background: "var(--tp-surface)" };

/** The rail as the Prospect surface mounts it: live per-value counts, owners, three facets applied. */
export const WithCounts = () => {
  const [query, setQuery] = useState(CONTACT_QUERY);
  const ref = useExpandGroups<HTMLDivElement>();
  return (
    <Shell>
      <div ref={ref} style={rail}>
        <FilterPanel query={query} onChange={setQuery} counts={FACET_COUNTS} owners={OWNERS} />
      </div>
    </Shell>
  );
};

/** Counts unavailable (facet request still in flight, or a surface that doesn't compute them) and nothing
 *  applied — so no group badges and no "Clear all". */
export const WithoutCounts = () => {
  const [query, setQuery] = useState({ ...CONTACT_QUERY, filters: [] });
  const ref = useExpandGroups<HTMLDivElement>();
  return (
    <Shell>
      <div ref={ref} style={rail}>
        <FilterPanel query={query} onChange={setQuery} />
      </div>
    </Shell>
  );
};
