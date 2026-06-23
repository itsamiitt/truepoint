// ProspectToolbar.tsx — the compact results-header controls (24): a sort control bound to the server
// ContactQuery.sort (the three contract values relevance|score_desc|created_desc with friendly labels) and a
// column-chooser dropdown of checkboxes toggling which result columns are visible. Presentation only — the page
// owns the query + the visible-column set; this just renders the controls and fires the supplied callbacks.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { DropdownMenu, TpCheckbox, TpIconButton, TpSelect } from "@leadwolf/ui";
import { Columns3 } from "lucide-react";

/** The three contract sort modes (search.ts contactQuery.sort), with their friendly results-header labels. */
const SORT_OPTIONS: { value: ContactQuery["sort"]; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "score_desc", label: "Score" },
  { value: "created_desc", label: "Date added" },
];

export function ProspectToolbar({
  query,
  onChange,
  columns,
  visibleColumns,
  onVisibleColumnsChange,
}: {
  /** The active search query; `query.sort` drives the sort control. */
  query: ContactQuery;
  /** Commit a query change (e.g. a new sort) back to the page. */
  onChange: (q: ContactQuery) => void;
  /** All toggleable result columns (key + display label). */
  columns: { key: string; label: string }[];
  /** The keys currently shown. */
  visibleColumns: string[];
  /** Commit the next visible-column key set. */
  onVisibleColumnsChange: (keys: string[]) => void;
}) {
  const toggleColumn = (key: string) =>
    onVisibleColumnsChange(
      visibleColumns.includes(key)
        ? visibleColumns.filter((k) => k !== key)
        : [...visibleColumns, key],
    );

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--tp-space-2)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Sort</span>
        <TpSelect
          value={query.sort}
          onChange={(e) => onChange({ ...query, sort: e.target.value as ContactQuery["sort"] })}
          aria-label="Sort results"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </TpSelect>
      </span>

      <DropdownMenu
        align="end"
        trigger={({ toggle }) => (
          <TpIconButton label="Choose columns" onClick={toggle}>
            <Columns3 size={16} />
          </TpIconButton>
        )}
        items={columns.map((col) => ({
          // Render a checkbox row; keep the menu open by toggling via the checkbox change, not onSelect.
          label: (
            <TpCheckbox
              checked={visibleColumns.includes(col.key)}
              onChange={() => toggleColumn(col.key)}
              label={col.label}
            />
          ),
        }))}
      />
    </div>
  );
}
