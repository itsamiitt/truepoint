// FilterRail.tsx — the People tab's filter rail (24 §2; decisions.md 2026-08-25), Search v4 shape: the rail
// renders as a CARD (search.module.css owns that treatment on the drawer body); quick facets first (the
// facets both engines answer), each a closed-by-default disclosure row whose right edge summarises what is
// selected; then the "All filters" groups under a plain heading; then Saved searches as a closed disclosure
// (the dialogs/menu behind it stay next/dynamic — opening it is the intent that fetches them). The
// semantics line says the one rule the rail follows. Presentation only — the page owns query state, URL
// persistence, and counts.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import { TpButton } from "@leadwolf/ui";
import { type ReactNode, useState } from "react";
import { clearAllFilters, hasActiveFilters } from "../filterGroups";
import styles from "../prospect.module.css";
import { AllFiltersSection } from "./AllFiltersSection";
import type { OwnerOption } from "./FacetControl";
import { QuickFilters } from "./QuickFilters";
import { RailChevron } from "./RailChevron";

export type { OwnerOption } from "./FacetControl";

/** The two numbers the rail's stat card shows — pre-formatted by the pane (floors carry a trailing "+"). */
export interface RailStats {
  /** Everyone the applied filters match, both engines (saved + database). */
  total: string;
  /** How many of them are already saved in this workspace. */
  saved: string;
}

export function FilterRail({
  query,
  onChange,
  counts,
  owners = [],
  scope,
  stats,
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
  /** The result numbers for the stat card at the top of the rail (replaced the results-area headline). */
  stats?: RailStats;
  /** Saved + recent searches, rendered when the Saved searches disclosure is opened. */
  footer?: ReactNode;
}) {
  const [savedOpen, setSavedOpen] = useState(false);
  return (
    <aside className={styles.rail} aria-label="Filters">
      {stats ? (
        <div className={styles.railStats}>
          <div className={styles.railStat}>
            <span className={styles.railStatNum}>{stats.total}</span>
            <span className={styles.railStatLabel}>Matching</span>
          </div>
          <div className={styles.railStat}>
            <span className={styles.railStatNum}>{stats.saved}</span>
            <span className={styles.railStatLabel}>Saved</span>
          </div>
        </div>
      ) : null}
      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <span className={styles.railHeadActions}>
            {/* The save action used to live ONLY inside the closed Saved-searches disclosure — a first-time
                user could filter for an hour and never learn searches can be kept. This opens that section. */}
            {footer != null ? (
              <TpButton variant="ghost" size="sm" onClick={() => setSavedOpen(true)}>
                Save
              </TpButton>
            ) : null}
            <TpButton variant="ghost" size="sm" onClick={() => onChange(clearAllFilters(query))}>
              Clear all
            </TpButton>
          </span>
        ) : null}
      </div>
      <p className={styles.semantics}>Matches all groups · any value within a group</p>
      {/* The option counts come from the workspace engine — in "All" they describe the saved half only.
          (In "Not saved" the pane passes no counts at all: a wrong number is worse than none.) */}
      {counts !== undefined && scope === "all" ? (
        <p className={styles.semantics}>Option counts reflect your saved contacts.</p>
      ) : null}

      <QuickFilters query={query} onChange={onChange} counts={counts} owners={owners} />
      <AllFiltersSection
        query={query}
        onChange={onChange}
        counts={counts}
        owners={owners}
        scope={scope}
      />

      {footer != null ? (
        <section className={styles.railSec}>
          <button
            type="button"
            className={styles.tierHead}
            aria-expanded={savedOpen}
            aria-controls="search-saved-searches"
            onClick={() => setSavedOpen((o) => !o)}
          >
            <span className={styles.groupTitle}>Saved searches</span>
            <RailChevron />
          </button>
          {savedOpen ? (
            <div id="search-saved-searches" className={styles.railSection}>
              {footer}
            </div>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
