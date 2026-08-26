// QuickFilters.tsx — the always-visible tier of the rail (decisions.md 2026-08-25): exactly the facets both
// the workspace and the global engine answer, so a new user's first filter never makes half the list vanish.
// The two booleans sit side by side; everything else is a labelled control with an example placeholder.
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
  const terms = QUICK_FACETS.filter((f) => f.kind !== "bool");
  const bools = QUICK_FACETS.filter((f) => f.kind === "bool");
  return (
    <div className={styles.quick}>
      {terms.map((facet) => (
        <FacetControl
          key={`${facet.kind}:${facet.field}`}
          facet={facet}
          query={query}
          onChange={onChange}
          counts={counts}
          owners={owners}
        />
      ))}
      <div className={styles.quickPair}>
        {bools.map((facet) => (
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
    </div>
  );
}
