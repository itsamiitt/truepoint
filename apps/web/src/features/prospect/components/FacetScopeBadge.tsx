// FacetScopeBadge.tsx — the "Workspace only" mark on a filter control the platform database cannot answer.
//
// Applying one of these skips the global half of the results entirely (see ScopeNotice for why that is the
// right semantics). The notice above the grid explains it after the fact; this says it BEFORE the click, on
// the control itself, so the narrowing is a choice rather than a surprise.
"use client";

import { Tooltip } from "@leadwolf/ui";
import type { FacetScope } from "../filterGroups";
import styles from "../prospect.module.css";

export function FacetScopeBadge({ scope }: { scope: FacetScope }) {
  if (scope !== "workspace-only") return null;
  return (
    <Tooltip label="Only records already in your workspace carry this field, so filtering by it does not search the platform database.">
      <span className={styles.scopeBadge}>Workspace only</span>
    </Tooltip>
  );
}
