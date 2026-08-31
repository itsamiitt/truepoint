// FilterRail.tsx — the People tab's filter rail (24 §2; decisions.md 2026-08-25). Two tiers: QUICK filters
// (the facets both engines answer), then "All filters" (one-side-only facets) in accordion groups. Every
// facet is itself a closed-by-default disclosure row (2026-08-31 rail simplification) — the rail reads as a
// compact list of labels until the user opens one. The saved/recent searches live BELOW the filters, so a
// first-time user meets the controls before the chrome. The semantics line says the one rule the rail
// follows. Presentation only — the page owns query state, URL persistence, and counts.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import { TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { clearAllFilters, hasActiveFilters } from "../filterGroups";
import styles from "../prospect.module.css";
import { AllFiltersSection } from "./AllFiltersSection";
import type { OwnerOption } from "./FacetControl";
import { QuickFilters } from "./QuickFilters";

export type { OwnerOption } from "./FacetControl";

export function FilterRail({
  query,
  onChange,
  counts,
  owners = [],
  scope,
  footer,
}: {
  query: ContactQuery;
  onChange: (next: ContactQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/facets). Optional. */
  counts?: Map<string, number>;
  /** Teammates (+ a "Me" entry the page prepends) for the Owner facet. */
  owners?: OwnerOption[];
  /** All / Saved / Not saved — in "Not saved" the saved-only tier cannot apply and says so. */
  scope: WorkspaceScope;
  /** Rail content rendered UNDER the filters (saved + recent searches). */
  footer?: ReactNode;
}) {
  return (
    <aside className={styles.rail} aria-label="Filters">
      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <TpButton variant="ghost" size="sm" onClick={() => onChange(clearAllFilters(query))}>
            Clear all
          </TpButton>
        ) : null}
      </div>
      <p className={styles.semantics}>Matches all groups · any value within a group</p>

      <QuickFilters query={query} onChange={onChange} counts={counts} owners={owners} />
      <AllFiltersSection
        query={query}
        onChange={onChange}
        counts={counts}
        owners={owners}
        scope={scope}
      />

      {footer != null ? <div className={styles.railSection}>{footer}</div> : null}
    </aside>
  );
}
