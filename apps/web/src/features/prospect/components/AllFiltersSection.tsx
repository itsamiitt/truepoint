// AllFiltersSection.tsx — the second tier of the rail (decisions.md 2026-08-25): every facet that searches
// ONE side only, under one collapsible "All filters" header. Collapsed by default (progressive disclosure);
// the badge counts active selections so a collapsed tier is still legible. Each group inside is tagged with
// the side it searches ("Workspace only" narrows to saved contacts; "Database only" searches the TruePoint
// database instead), and a scope that already rules a side out hides those groups with a one-line note
// rather than offering controls that would silently do nothing.
//
// The header is eager; the BODY (the groups) is next/dynamic — opening the tier is an intent (perf-checklist
// PA-3), and /search has a 200kB First Load budget the quick tier + grid must fit inside.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import dynamic from "next/dynamic";
import { ALL_FILTER_GROUPS, groupActiveCount } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import type { OwnerOption } from "./FacetControl";

const AllFiltersBody = dynamic(() => import("./AllFiltersBody").then((m) => m.AllFiltersBody), {
  ssr: false,
  loading: () => <p className={styles.tierNote}>Loading filters…</p>,
});

const TIER_ID = "search-all-filters";
const NARROWING_FIELDS = ALL_FILTER_GROUPS.flatMap((g) => g.facets.map((f) => f.field));

export function AllFiltersSection({
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
  const active = groupActiveCount(query, NARROWING_FIELDS);
  const open = groups.isOpen("all");

  return (
    <section className={styles.tier}>
      <button
        type="button"
        className={styles.tierHead}
        aria-expanded={open}
        aria-controls={TIER_ID}
        onClick={() => groups.toggle("all")}
      >
        <span className={styles.groupTitle}>
          All filters
          {active > 0 ? <span className={styles.groupBadge}>{active}</span> : null}
        </span>
        <span className={styles.tierTag}>One side at a time</span>
        <span aria-hidden className={styles.groupChevron}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div id={TIER_ID}>
          <AllFiltersBody
            query={query}
            onChange={onChange}
            counts={counts}
            owners={owners}
            scope={scope}
          />
        </div>
      ) : null}
    </section>
  );
}
