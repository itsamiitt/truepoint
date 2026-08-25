// AccountsSort.tsx — the sort control for the Accounts results grid.
//
// `AccountQuery.sort` has carried four values since the contract was written and the repository has always
// honoured them, but no Accounts surface ever rendered a control — so three of the four were unreachable
// and the grid was permanently on "relevance". The People pane has had its equivalent (inside
// ProspectToolbar) all along; this is the missing twin, kept separate because sort values ARE query-shaped
// and the two queries are different types.
"use client";

import type { AccountQuery } from "@leadwolf/types";
import { TpSelect } from "@leadwolf/ui";

/** The four contract sort modes (accountsSearch.ts accountQuery.sort), with results-header labels. */
const SORT_OPTIONS: { value: AccountQuery["sort"]; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "name_asc", label: "Name" },
  { value: "headcount_desc", label: "Headcount" },
  { value: "created_desc", label: "Date added" },
];

export function AccountsSort({
  query,
  onChange,
}: {
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>Sort</span>
      <TpSelect
        value={query.sort}
        onChange={(e) => onChange({ ...query, sort: e.target.value as AccountQuery["sort"] })}
        aria-label="Sort companies"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </TpSelect>
    </span>
  );
}
