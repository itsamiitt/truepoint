// FacetScopeBadge.tsx — the "Database only" mark on a filter control the workspace overlay cannot answer.
//
// Applying one of these skips the workspace half of the results entirely (see ScopeNotice for why that is
// the right semantics). The notice above the grid explains it after the fact; this says it BEFORE the
// click, on the control itself, so the narrowing is a choice rather than a surprise. Workspace-only facets
// deliberately carry NO badge (2026-08-31): the saved-contacts side is the default, and labelling most of
// the rail taught nothing — the ScopeNotice still explains the narrowing when one applies.
"use client";

import { Tooltip } from "@leadwolf/ui";
import type { FacetScope } from "../filterGroups";
import styles from "../prospect.module.css";

const COPY: Record<string, { label: string; tip: string }> = {
  "database-only": {
    label: "Database only",
    tip: "Only the platform database records this, so filtering by it searches the database rather than your own contacts. People you already hold still appear, marked.",
  },
};

export function FacetScopeBadge({ scope }: { scope: FacetScope }) {
  const copy = COPY[scope];
  // `both` and `workspace-only` have no badge — see above.
  if (!copy) return null;
  return (
    <Tooltip label={copy.tip}>
      <span className={styles.scopeBadge}>{copy.label}</span>
    </Tooltip>
  );
}
