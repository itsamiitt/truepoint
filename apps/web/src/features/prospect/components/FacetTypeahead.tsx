// FacetTypeahead.tsx — a search-box filter facet (24 §3): type to get suggestions drawn from the index
// (each with its match count), pick one to add a chip. Title suggestions are synonym/abbreviation aware
// server-side, so typing "ceo" surfaces "Chief Executive Officer". Token-styled via @leadwolf/ui.
"use client";

import type { FacetKey } from "@leadwolf/types";
import { TpChip, TpInput } from "@leadwolf/ui";
import { useState } from "react";
import { useTypeahead } from "../hooks/useTypeahead";

export function FacetTypeahead({
  field,
  label,
  selected,
  onAdd,
  onRemove,
}: {
  field: FacetKey;
  label: string;
  selected: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const { query, setQuery, suggestions, loading } = useTypeahead(field);
  const [open, setOpen] = useState(false);
  const showMenu = open && query.trim().length >= 3;

  return (
    <div className="tp-ui-anchor" style={{ display: "block" }}>
      <div style={{ fontSize: 12, color: "var(--tp-ink-4)", marginBottom: 4 }}>{label}</div>
      <TpInput
        value={query}
        placeholder={`Search ${label.toLowerCase()}…`}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {showMenu ? (
        <div
          className="tp-ui-popover tp-ui-popover--start"
          role="listbox"
          style={{ width: "100%", maxHeight: 260, overflow: "auto" }}
        >
          <div className="tp-ui-menu">
            {loading ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                Searching…
              </div>
            ) : suggestions.length === 0 ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                No matches
              </div>
            ) : (
              suggestions.map((s) => (
                <button
                  key={s.canonicalId ?? s.value}
                  type="button"
                  role="option"
                  className="tp-ui-menu-item"
                  onClick={() => {
                    onAdd(s.value);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span style={{ flex: 1 }}>{s.displayLabel}</span>
                  <span style={{ color: "var(--tp-ink-4)", fontSize: 12 }}>
                    {s.count.toLocaleString()}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
      {selected.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {selected.map((v) => (
            <TpChip key={v} onRemove={() => onRemove(v)}>
              {v}
            </TpChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
