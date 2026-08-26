// FacetTypeahead.tsx — a search-box value picker for a high-cardinality facet (24 §3): type to get suggestions
// drawn from the index (each with its match count), pick one to add it. Title suggestions are synonym/
// abbreviation aware server-side, so typing "ceo" surfaces "Chief Executive Officer". It is a PICKER only —
// the facet's label and its applied values are owned by the caller (TermFacetField), so one instance serves
// the include direction and one the exclude direction.
//
// Fully keyboard-operable (WCAG 2.2 AA): ↑ ↓ Home End move the highlight, Enter picks, Escape closes — the
// pure reducer in ../typeaheadKeys decides, so the behaviour is unit-tested. The input is a combobox with
// aria-activedescendant; the list is a listbox of options. Below the facet's minimum the picker SAYS how many
// more characters it needs instead of showing nothing.
"use client";

import type { FacetKey } from "@leadwolf/types";
import { TpInput } from "@leadwolf/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { TermOp } from "../filterGroups";
import { type TypeaheadSource, useTypeahead } from "../hooks/useTypeahead";
import { optionId, typeaheadKey } from "../typeaheadKeys";

function Hint({ children }: { children: string }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        color: "var(--tp-ink-3)",
        fontSize: "var(--tp-text-body)",
      }}
    >
      {children}
    </div>
  );
}

export function FacetTypeahead({
  field,
  label,
  selected,
  onAdd,
  op = "include",
  autoFocus = false,
  placeholder,
  source = "workspace",
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
  /** An EXAMPLE of the input ("e.g. VP Sales, CTO"); the label stays the label. */
  placeholder?: string;
  /** Which suggest endpoint answers — the global one for a database-only facet (see useTypeahead). */
  source?: TypeaheadSource;
}) {
  const { query, setQuery, suggestions, loading, minChars } = useTypeahead(field, source);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const typed = query.trim().length;
  const showMenu = open && typed > 0;
  const hits = suggestions.filter((s) => !selected.includes(s.value));
  const short = typed > 0 && typed < minChars;

  useEffect(() => {
    // TpInput renders a plain <input> and takes no ref, so reach it through the anchor.
    if (autoFocus) anchorRef.current?.querySelector("input")?.focus();
  }, [autoFocus]);

  // The highlight is meaningless once the list under it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the list changing, not on its items
  useEffect(() => setActiveIndex(-1), [hits.length, query]);

  const pick = (value: string) => {
    onAdd(value);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div ref={anchorRef} className="tp-ui-anchor" style={{ display: "block" }}>
      <TpInput
        value={query}
        role="combobox"
        aria-label={op === "exclude" ? `${label} to exclude` : `Search ${label.toLowerCase()}`}
        aria-expanded={showMenu}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showMenu && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined
        }
        placeholder={
          op === "exclude"
            ? `${label} to exclude…`
            : (placeholder ?? `Search ${label.toLowerCase()}…`)
        }
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          const next = typeaheadKey({ open: showMenu, activeIndex }, e.key, hits.length);
          if (!next.handled) return;
          e.preventDefault();
          if (next.select) {
            const hit = hits[activeIndex];
            if (hit) pick(hit.value);
            return;
          }
          setOpen(next.open);
          setActiveIndex(next.activeIndex);
        }}
      />
      {showMenu ? (
        <div
          className="tp-ui-popover tp-ui-popover--start"
          style={{ width: "100%", maxHeight: 260, overflow: "auto" }}
        >
          <div
            className="tp-ui-menu"
            // biome-ignore lint/a11y/useSemanticElements: an ARIA combobox listbox popover, not a native <select>.
            role="listbox"
            tabIndex={-1}
            id={listId}
            aria-label={`${label} suggestions`}
          >
            {short ? (
              <Hint>{`Type ${minChars - typed} more ${minChars - typed === 1 ? "character" : "characters"}`}</Hint>
            ) : loading ? (
              <Hint>Searching…</Hint>
            ) : hits.length === 0 ? (
              <Hint>No matches</Hint>
            ) : (
              hits.map((s, i) => (
                <button
                  key={s.canonicalId ?? s.value}
                  type="button"
                  id={optionId(listId, i)}
                  // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox option (a clickable suggestion row).
                  role="option"
                  aria-selected={i === activeIndex}
                  className="tp-ui-menu-item"
                  style={{ background: i === activeIndex ? "var(--tp-surface-3)" : undefined }}
                  // Keep focus in the input: a mousedown would blur it and close the list before the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pick(s.value)}
                >
                  <span style={{ flex: 1 }}>{s.displayLabel}</span>
                  <span style={{ color: "var(--tp-ink-3)", fontSize: "var(--tp-text-caption)" }}>
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
