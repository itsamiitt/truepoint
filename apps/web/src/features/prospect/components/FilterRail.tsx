// FilterRail.tsx — the search-box-first filter rail (24 §2): one FacetTypeahead per high-cardinality facet,
// each adding include chips. Emits the active filter set as FilterClause[] so the page can run the search.
// Reference composition for the prospect slice; the web agent wires it into ProspectPage's left rail.
"use client";

import type { FacetKey, FilterClause } from "@leadwolf/types";
import { useState } from "react";
import { FacetTypeahead } from "./FacetTypeahead";

const FACETS: { field: FacetKey; label: string }[] = [
  { field: "title", label: "Job title" },
  { field: "company", label: "Company" },
  { field: "location", label: "Location" },
];

export function FilterRail({ onChange }: { onChange: (filters: FilterClause[]) => void }) {
  const [byField, setByField] = useState<Record<string, string[]>>({});

  function emit(next: Record<string, string[]>) {
    setByField(next);
    const filters: FilterClause[] = Object.entries(next)
      .filter(([, values]) => values.length > 0)
      .map(
        ([field, values]): FilterClause => ({
          kind: "term",
          field: field as FacetKey,
          op: "include",
          values,
        }),
      );
    onChange(filters);
  }

  function add(field: FacetKey, value: string) {
    const current = byField[field] ?? [];
    if (current.includes(value)) return;
    emit({ ...byField, [field]: [...current, value] });
  }

  function remove(field: FacetKey, value: string) {
    emit({ ...byField, [field]: (byField[field] ?? []).filter((v) => v !== value) });
  }

  return (
    <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {FACETS.map((f) => (
        <FacetTypeahead
          key={f.field}
          field={f.field}
          label={f.label}
          selected={byField[f.field] ?? []}
          onAdd={(v) => add(f.field, v)}
          onRemove={(v) => remove(f.field, v)}
        />
      ))}
    </aside>
  );
}
