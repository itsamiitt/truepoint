// AccountFilterPanel — the firmographic sidebar for the Accounts scope (24, ADR-0035): industry, tech,
// funding and company stage, revenue band, HQ country, headcount band. No PII facets — accounts carry none.
//
// Same collapsed-by-default accordion as FilterPanel, so both cells force the groups open on mount.
import { AccountFilterPanel } from "@leadwolf/ui";
import { useState } from "react";
import { ACCOUNT_FACET_COUNTS, ACCOUNT_QUERY } from "../prospect/fixtures";
import { Shell, useExpandGroups } from "./_prospectShell";

const rail: React.CSSProperties = { width: 264, background: "var(--tp-surface)" };

/** Industry and technology narrowed, with live per-value counts from /account-search/facets. */
export const WithCounts = () => {
  const [query, setQuery] = useState(ACCOUNT_QUERY);
  const ref = useExpandGroups<HTMLDivElement>();
  return (
    <Shell>
      <div ref={ref} style={rail}>
        <AccountFilterPanel query={query} onChange={setQuery} counts={ACCOUNT_FACET_COUNTS} />
      </div>
    </Shell>
  );
};

/** Nothing narrowed yet — every firmographic group at rest, no badges, no "Clear all". */
export const Unfiltered = () => {
  const [query, setQuery] = useState({ ...ACCOUNT_QUERY, filters: [] });
  const ref = useExpandGroups<HTMLDivElement>();
  return (
    <Shell>
      <div ref={ref} style={rail}>
        <AccountFilterPanel query={query} onChange={setQuery} counts={ACCOUNT_FACET_COUNTS} />
      </div>
    </Shell>
  );
};
