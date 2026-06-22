// RecentSearches.tsx — the per-browser "recent searches" quick-shortcuts row (24 §, Done-When #4). Renders the
// last few non-empty queries the user ran as clickable chips that re-apply the query; distinct from the named,
// server-persisted saved searches. Presentation only — the recents list + persistence live in the
// useRecentSearches hook; this component just renders them and fires the supplied callbacks.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { TpChip } from "@leadwolf/ui";
import type { RecentSearch } from "../hooks/useRecentSearches";
import styles from "../prospect.module.css";

export function RecentSearches({
  recents,
  onApply,
  onClear,
}: {
  /** The recent searches to surface (newest first). Empty → the component renders nothing. */
  recents: RecentSearch[];
  /** Re-run a recent search by applying its stored query. */
  onApply: (q: ContactQuery) => void;
  /** Clear the whole recents list. */
  onClear: () => void;
}) {
  if (recents.length === 0) return null;

  return (
    <div
      aria-label="Recent searches"
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          color: "var(--tp-ink-4)",
        }}
      >
        Recent
      </span>
      <div className={styles.chipWrap} style={{ marginBottom: 0 }}>
        {recents.map((r) => (
          <TpChip key={r.id} onClick={() => onApply(r.query)}>
            {r.label}
          </TpChip>
        ))}
      </div>
      <button type="button" className="tp-ui-btn tp-ui-btn--link tp-ui-btn--sm" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
