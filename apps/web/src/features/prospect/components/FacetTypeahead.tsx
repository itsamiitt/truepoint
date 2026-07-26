// FacetTypeahead.tsx — a search-box value picker for a high-cardinality facet (24 §3): type to get suggestions
// drawn from the index (each with its match count), pick one to add it. Title suggestions are synonym/
// abbreviation aware server-side, so typing "ceo" surfaces "Chief Executive Officer". Token-styled via
// @leadwolf/ui. It is a PICKER only — the facet's label and its applied values are owned by the caller
// (TermFacetField), so one instance serves the include direction and one the exclude direction.
"use client";

import type { FacetKey } from "@leadwolf/types";
import { TpInput } from "@leadwolf/ui";
import { useEffect, useRef, useState } from "react";
import type { TermOp } from "../filterGroups";
import { useTypeahead } from "../hooks/useTypeahead";

export function FacetTypeahead({
  field,
  label,
  selected,
  onAdd,
  op = "include",
  autoFocus = false,
}: {
  field: FacetKey;
  label: string;
  /** Values already applied to this facet in EITHER direction — never suggested again. */
  selected: string[];
  onAdd: (value: string) => void;
  /** Which clause a pick lands in. Drives the placeholder; the rose field treatment comes from the block. */
  op?: TermOp;
  /** Focus the field on mount — set when the user just opened the exclude block. */
  autoFocus?: boolean;
}) {
  const { query, setQuery, suggestions, loading } = useTypeahead(field);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const showMenu = open && query.trim().length >= 3;
  const hits = suggestions.filter((s) => !selected.includes(s.value));

  useEffect(() => {
    // TpInput renders a plain <input> and takes no ref, so reach it through the anchor.
    if (autoFocus) anchorRef.current?.querySelector("input")?.focus();
  }, [autoFocus]);

  return (
    <div ref={anchorRef} className="tp-ui-anchor" style={{ display: "block" }}>
      <TpInput
        value={query}
        aria-label={op === "exclude" ? `${label} to exclude` : `Search ${label.toLowerCase()}`}
        placeholder={op === "exclude" ? `${label} to exclude…` : `Search ${label.toLowerCase()}…`}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {showMenu ? (
        <div
          className="tp-ui-popover tp-ui-popover--start"
          // biome-ignore lint/a11y/useSemanticElements: an ARIA combobox listbox popover, not a native <select>.
          role="listbox"
          tabIndex={-1}
          style={{ width: "100%", maxHeight: 260, overflow: "auto" }}
        >
          <div className="tp-ui-menu">
            {loading ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                Searching…
              </div>
            ) : hits.length === 0 ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                No matches
              </div>
            ) : (
              hits.map((s) => (
                <button
                  key={s.canonicalId ?? s.value}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox option (a clickable suggestion row).
                  role="option"
                  aria-selected={false}
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
    </div>
  );
}
