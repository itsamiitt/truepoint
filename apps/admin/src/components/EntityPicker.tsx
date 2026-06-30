"use client";
// EntityPicker.tsx — the generic async typeahead behind TenantPicker / UserPicker: it resolves a human-typed
// query to an entity id via a caller-supplied DEBOUNCED server search, so staff stop pasting raw UUIDs. Reuses
// the shared tp-ui popover classes (primitives.css); the input keeps role="combobox", the results are plain
// operable buttons (native keyboard activation); closes on outside-click + Esc. Controlled value=id;
// onChange(id, label). UX/convenience only — the api always re-validates + authorizes the id on the write,
// so a hand-typed or stale value can never bypass a check.

import { useEffect, useRef, useState } from "react";

export interface EntityOption {
  value: string;
  label: string;
  hint?: string;
}

export function EntityPicker({
  id,
  value,
  selectedLabel,
  onChange,
  search,
  disabled,
  placeholder = "Search…",
  emptyText = "No matches.",
}: {
  /** Optional input id so a wrapping <label htmlFor> can associate; also seeds the listbox id. */
  id?: string;
  /** The selected entity id, or "" when none is chosen yet. */
  value: string;
  /** Display label of the selected entity when known (e.g. just picked); falls back to the id otherwise. */
  selectedLabel?: string | null;
  onChange: (value: string, label: string) => void;
  /** Debounced server search — MUST be a stable reference (module-level fn or useCallback). */
  search: (query: string) => Promise<EntityOption[]>;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = id ? `${id}-list` : undefined;

  // Debounced search while the dropdown is open (250ms; cancels the in-flight result on each keystroke/close).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        const rows = await search(query.trim());
        if (!cancelled) {
          setHits(rows);
          setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, search]);

  // Close on outside-click + Esc (mirrors the kit Combobox).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const showChip = !!value && !open;

  return (
    <div className="tp-ui-anchor" ref={ref} style={{ display: "block" }}>
      {showChip ? (
        <button
          type="button"
          className="tp-ui-field"
          disabled={disabled}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            textAlign: "left",
          }}
          onClick={() => setOpen(true)}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedLabel ?? `${value.slice(0, 8)}…`}
          </span>
          <span aria-hidden style={{ color: "var(--tp-ink-4)", marginLeft: 8 }}>
            ▾
          </span>
        </button>
      ) : (
        <input
          id={id}
          className="tp-ui-field"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      )}
      {open ? (
        <div
          id={listId}
          className="tp-ui-popover tp-ui-popover--start"
          style={{ width: "100%", maxHeight: 280, overflow: "auto" }}
        >
          <div className="tp-ui-menu">
            {loading ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                Searching…
              </div>
            ) : hits.length === 0 ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                {emptyText}
              </div>
            ) : (
              hits.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="tp-ui-menu-item"
                  onClick={() => {
                    onChange(o.value, o.label);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {o.hint != null ? (
                    <span style={{ color: "var(--tp-ink-4)", fontSize: 12 }}>{o.hint}</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
