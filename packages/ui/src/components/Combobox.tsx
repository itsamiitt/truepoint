"use client";
// Combobox.tsx — a searchable single-select (filter facets, identity/template pickers). Token-styled; filters
// options by a query, closes on outside-click + Esc (24 §2 large value sets). Controlled value + onChange.
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../cn.ts";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  className,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div className="tp-ui-anchor" ref={ref} style={{ display: "block" }}>
      <button
        type="button"
        className={cn("tp-ui-field", className)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          textAlign: "left",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          style={{
            color: selected ? "var(--tp-ink)" : "var(--tp-ink-4)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected ? selected.label : placeholder}
        </span>
        <span aria-hidden style={{ color: "var(--tp-ink-4)", marginLeft: 8 }}>
          ▾
        </span>
      </button>
      {open ? (
        <div
          className="tp-ui-popover tp-ui-popover--start"
          role="listbox"
          style={{ width: "100%", maxHeight: 280, overflow: "auto" }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--tp-hairline)" }}>
            {/* biome-ignore lint/a11y/noAutofocus: focus the search field when the listbox opens */}
            <input
              className="tp-ui-field"
              autoFocus
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="tp-ui-menu">
            {filtered.length === 0 ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                {emptyText}
              </div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className="tp-ui-menu-item"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setQuery("");
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
