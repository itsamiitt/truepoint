// AccountFilterPanel.tsx — the firmographic filter rail (the Accounts sibling of FilterRail; decisions.md
// 2026-08-25). Two tiers: QUICK filters — exactly the facets the global company graph answers too
// (industry, HQ country/city, employees, founded year) — then "All filters", the saved-accounts
// firmographics in accordion groups collapsed by default (active-count badge per header, open state
// persisted). Every facet is itself a closed-by-default disclosure row (2026-08-31 rail simplification).
// Term facets use the PROGRESSIVE EXCLUDE pattern (TermFacetField). The Prospect/Account scope switch is
// hosted at the top of the rail. Presentation only — the pane owns query state, URL persistence, counts.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { AccountQuery } from "@leadwolf/types";
import { TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";
import {
  ACCOUNT_ALL_FILTER_GROUPS,
  ACCOUNT_QUICK_FACETS,
  clearAllFilters,
  groupActiveCount,
  hasActiveFilters,
} from "../accountFilterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import { AccordionGroup } from "./AccordionGroup";
import { AccountFacetControl } from "./AccountFacetControl";

export function AccountFilterPanel({
  query,
  onChange,
  counts,
  scopeSwitch,
  scope,
}: {
  query: AccountQuery;
  onChange: (next: AccountQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/accounts/facets). Optional. */
  counts?: Map<string, number>;
  /** The Prospect/Account scope switch, hosted at the top of the sidebar. */
  scopeSwitch?: ReactNode;
  /** All / Saved / Not saved — in "Not saved" the workspace-only tier cannot apply and says so. */
  scope: WorkspaceScope;
}) {
  // Namespaced ids so the Accounts rail's open state never collides with the People rail's.
  const groups = useOpenGroups();

  return (
    <aside className={styles.rail} aria-label="Company filters">
      {scopeSwitch != null ? <div className={styles.railScope}>{scopeSwitch}</div> : null}

      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <TpButton variant="ghost" size="sm" onClick={() => onChange(clearAllFilters(query))}>
            Clear all
          </TpButton>
        ) : null}
      </div>
      <p className={styles.semantics}>Matches all groups · any value within a group</p>

      <div className={styles.quick}>
        {ACCOUNT_QUICK_FACETS.map((facet) => (
          <AccountFacetControl
            key={`${facet.kind}:${facet.field}`}
            facet={facet}
            query={query}
            onChange={onChange}
            counts={counts}
          />
        ))}
      </div>

      <section className={styles.railSec}>
        <h3 className={styles.railSecTitle}>All filters</h3>
        {scope === "exclude" ? (
          <p className={styles.tierNote}>
            Filters on your saved accounts don't apply to companies you haven't saved yet — switch
            to All or Saved to use them.
          </p>
        ) : (
          ACCOUNT_ALL_FILTER_GROUPS.map((group) => (
            <AccordionGroup
              key={group.id}
              id={`accounts-group-${group.id}`}
              title={group.title}
              open={groups.isOpen(`accounts-${group.id}`)}
              onToggle={() => groups.toggle(`accounts-${group.id}`)}
              badge={
                groupActiveCount(
                  query,
                  group.facets.map((f) => f.field),
                ) || undefined
              }
            >
              {group.facets.map((facet) => (
                <AccountFacetControl
                  key={`${facet.kind}:${facet.field}`}
                  facet={facet}
                  query={query}
                  onChange={onChange}
                  counts={counts}
                />
              ))}
            </AccordionGroup>
          ))
        )}
      </section>
    </aside>
  );
}
