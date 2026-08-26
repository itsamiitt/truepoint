"use client";
// Combobox.tsx — a searchable single-select (filter facets, identity/template pickers). Token-styled;
// controlled value + onChange; closes on outside-click + Esc (24 §2 large value sets).
//
// Implements the ARIA combobox-with-listbox pattern properly: the SEARCH INPUT is the combobox (it keeps
// DOM focus and points at the visually-active option via aria-activedescendant), and the listbox contains
// ONLY options — the previous shape put role="listbox" around the input too, which is invalid (a listbox
// may only contain options) and left arrow keys doing nothing. Escape/selection return focus to the
// trigger so keyboard users are not stranded.
//
// For server-driven pickers pass `onQueryChange` (called as the user types — debounce upstream) and
// `loading`; the DS then renders the searching state instead of "no matches".
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.ts";
import { isTopLayer, popLayer, pushLayer } from "./overlayStack.ts";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  onQueryChange,
  loading = false,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  loadingText = "Searching…",
  className,
  id,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Called as the query changes — for server-side search. Without it, options filter client-side. */
  onQueryChange?: (query: string) => void;
  /** Show the searching state (pairs with onQueryChange). */
  loading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  loadingText?: string;
  className?: string;
  /** Put on the trigger, so a sibling <label htmlFor> has something real to point at. */
  id?: string;
  disabled?: boolean;
  /** Name the trigger directly when there is no visible label to associate. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const filtered = useMemo(() => {
    // With a server search the caller already narrowed `options`; filtering again would fight it.
    if (onQueryChange) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, onQueryChange]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    onQueryChange?.("");
    if (restoreFocus) triggerRef.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const handle = Symbol("tp-combobox");
    pushLayer(handle, { lock: false });
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(handle)) {
        e.stopPropagation();
        closeRef.current(true);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      popLayer(handle);
    };
  }, [open]);

  // Clamp the active option when the result set changes, and keep it scrolled into view.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: optionId is stable (derived from useId)
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[id="${optionId(activeIndex)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const select = (option: ComboOption) => {
    onChange(option.value);
    close(true);
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = filtered[activeIndex];
      if (option) select(option);
    }
    // Escape is handled by the document listener (top-most layer only).
  };

  const selected = options.find((o) => o.value === value) ?? null;
  const isOpen = open && !disabled;

  return (
    <div className="tp-ui-anchor" ref={ref} style={{ display: "block" }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
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
        <span aria-hidden style={{ color: "var(--tp-ink-4)", marginLeft: "var(--tp-space-2)" }}>
          ▾
        </span>
      </button>
      {isOpen ? (
        <div
          className="tp-ui-popover tp-ui-popover--start"
          style={{ width: "100%", maxHeight: 280, overflow: "auto" }}
        >
          <div
            style={{ padding: "var(--tp-space-2)", borderBottom: "1px solid var(--tp-hairline)" }}
          >
            <input
              className="tp-ui-field"
              // biome-ignore lint/a11y/noAutofocus: focus the search field when the listbox opens
              autoFocus
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={filtered.length > 0 ? optionId(activeIndex) : undefined}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
                onQueryChange?.(e.target.value);
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>
          <div
            className="tp-ui-menu"
            // Programmatically focusable but NOT a tab stop: the search input keeps DOM focus and points
            // here with aria-activedescendant, which is the pattern's whole mechanism. (Same shape as
            // apps/web's FacetTypeahead, which scripts/lint-roving-tabindex.mjs documents as the correct
            // use of tabIndex={-1} on a container.)
            tabIndex={-1}
            // biome-ignore lint/a11y/useSemanticElements: a <select> cannot host a search field + hints
            role="listbox"
            id={listboxId}
            ref={listRef}
          >
            {loading ? (
              <div
                style={{
                  padding: "8px 10px",
                  color: "var(--tp-ink-3)",
                  fontSize: "var(--tp-text-body)",
                }}
                // biome-ignore lint/a11y/useSemanticElements: <output> takes phrasing content only
                role="status"
              >
                {loadingText}
              </div>
            ) : filtered.length === 0 ? (
              <div
                style={{
                  padding: "8px 10px",
                  color: "var(--tp-ink-3)",
                  fontSize: "var(--tp-text-body)",
                }}
              >
                {emptyText}
              </div>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.value}
                  id={optionId(i)}
                  type="button"
                  // Not tab-reachable: the search input keeps DOM focus and steers via aria-activedescendant.
                  tabIndex={-1}
                  // biome-ignore lint/a11y/useSemanticElements: ARIA option pattern on a real button; <option> only lives in <select>
                  role="option"
                  aria-selected={o.value === value}
                  className={cn("tp-ui-menu-item", i === activeIndex && "tp-ui-menu-item--active")}
                  onClick={() => select(o)}
                  onMouseMove={() => setActiveIndex(i)}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {o.hint != null ? (
                    <span style={{ color: "var(--tp-ink-3)", fontSize: "var(--tp-text-caption)" }}>
                      {o.hint}
                    </span>
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
