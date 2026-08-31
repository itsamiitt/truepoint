// QuickFilters.tsx — the top tier of the rail (decisions.md 2026-08-25): exactly the facets both the
// workspace and the global engine answer, so a new user's first filter never makes half the list vanish.
// Every facet renders as a closed-by-default disclosure row (2026-08-31 rail simplification) — the rail
// stays one compact list of labels until the user opens the one they want.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { QUICK_FACETS } from "../filterGroups";
import styles from "../prospect.module.css";
import { FacetControl, type OwnerOption } from "./FacetControl";

export function QuickFilters({
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
  return (
    <div className={styles.quick}>
      {QUICK_FACETS.map((facet) => (
        <FacetControl
          key={`${facet.kind}:${facet.field}`}
          facet={facet}
          query={query}
          onChange={onChange}
          counts={counts}
          owners={owners}
        />
      ))}
    </div>
  );
}
