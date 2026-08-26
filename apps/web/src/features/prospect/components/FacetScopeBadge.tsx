// FacetScopeBadge.tsx — the "Workspace only" mark on a filter control the platform database cannot answer.
//
// Applying one of these skips the global half of the results entirely (see ScopeNotice for why that is the
// right semantics). The notice above the grid explains it after the fact; this says it BEFORE the click, on
// the control itself, so the narrowing is a choice rather than a surprise.
"use client";

import { Tooltip } from "@leadwolf/ui";
import type { FacetScope } from "../filterGroups";
import styles from "../prospect.module.css";

const COPY: Record<string, { label: string; tip: string }> = {
  "workspace-only": {
    label: "Workspace only",
    tip: "Only records already in your workspace carry this field, so filtering by it does not search the platform database.",
  },
  "database-only": {
    label: "Database only",
    tip: "Only the platform database records this, so filtering by it searches the database rather than your own contacts. People you already hold still appear, marked.",
  },
};

export function FacetScopeBadge({ scope }: { scope: FacetScope }) {
  const copy = COPY[scope];
  // `both` has no badge — a facet that works everywhere needs no explanation.
  if (!copy) return null;
  return (
    <Tooltip label={copy.tip}>
      <span className={styles.scopeBadge}>{copy.label}</span>
    </Tooltip>
  );
}
