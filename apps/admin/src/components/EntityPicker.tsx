"use client";
// EntityPicker.tsx — the generic async typeahead behind TenantPicker / UserPicker: it resolves a human-typed
// query to an entity id via a caller-supplied server search, so staff stop pasting raw UUIDs. Controlled
// value=id; onChange(id, label). UX/convenience only — the api always re-validates + authorizes the id on the
// write, so a hand-typed or stale value can never bypass a check.
//
// THE WIDGET IS THE DS <Combobox> NOW, not a hand-rolled one. The previous version reached into the DS's
// INTERNAL classes (tp-ui-anchor / tp-ui-field / tp-ui-popover / tp-ui-menu) and rebuilt the widget on top of
// them, which meant it inherited the LOOK of a combobox and none of the behaviour: role="combobox" with no
// aria-activedescendant, results that were neither a listbox nor options, and no arrow keys at all — so the
// only way to pick a row was the mouse. The DS component implements the full ARIA combobox pattern
// (arrows/Home/End/Enter/Escape, aria-activedescendant, focus return to the trigger), and its `onQueryChange`
// + `loading` props exist precisely for a server-driven picker like this one. Everything below is the SEARCH
// half; the widget half is the DS's.
//
// LABELLING. The DS Combobox's trigger is a button it owns, so there is no id to point a `<label htmlFor>` at.
// Wrap the picker in the label instead — `<label><span>Tenant</span><TenantPicker …/></label>` — which is the
// same shape apps/web's ReportsPage uses for its Combobox filters. The `id` prop below still lands on the
// read-only field rendered in the DISABLED state, which is the one state that renders a labelable element.
//
// A REJECTED SEARCH IS A STATE, NOT A HANG. The old effect awaited search(...) with no try/catch: one failed
// request left `loading` true forever and the menu stuck on "Searching…" with no way back. The catch below
// turns it into a message the user can act on, and `finally` guarantees the spinner clears either way.

import { type ComboOption, Combobox, TpInput } from "@leadwolf/ui";
import { useEffect, useMemo, useState } from "react";

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
  /** Id for the read-only field rendered while `disabled`. When enabled, wrap the picker in its `<label>`. */
  id?: string;
  /** The selected entity id, or "" when none is chosen yet. */
  value: string;
  /** Display label of the selected entity when known (e.g. just picked); falls back to the id otherwise. */
  selectedLabel?: string | null;
  onChange: (value: string, label: string) => void;
  /** Server search — MUST be a stable reference (module-level fn or useCallback); it is an effect dependency. */
  search: (query: string) => Promise<EntityOption[]>;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Debounced search (250ms; the in-flight result is dropped on each keystroke). It runs once on mount with
  // the empty query so the first open already shows the top matches — the DS Combobox owns its open state and
  // does not report it, so the alternative is a menu that says "No matches" until you type. A DISABLED picker
  // does not search at all; enabling it is a dependency change, so the first list arrives with the control.
  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const rows = await search(query.trim());
          if (cancelled) return;
          setHits(rows);
          setFailed(false);
        } catch {
          if (cancelled) return;
          setHits([]);
          setFailed(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, search, disabled]);

  // The current selection is pinned into the option list even when the live results no longer contain it —
  // the Combobox renders its trigger from `options.find(o => o.value === value)`, so without this the trigger
  // would fall back to the placeholder the moment the user typed something that filtered the selection out.
  const options: ComboOption[] = useMemo(() => {
    const rows: ComboOption[] = hits.map((h) => ({
      value: h.value,
      label: h.label,
      hint: h.hint,
    }));
    if (value && !rows.some((r) => r.value === value)) {
      rows.unshift({ value, label: selectedLabel ?? `${value.slice(0, 8)}…` });
    }
    return rows;
  }, [hits, value, selectedLabel]);

  if (disabled) {
    return (
      <TpInput
        id={id}
        readOnly
        disabled
        value={selectedLabel ?? (value ? `${value.slice(0, 8)}…` : "")}
        placeholder={placeholder}
      />
    );
  }

  return (
    <Combobox
      options={options}
      value={value || null}
      onChange={(next) => onChange(next, options.find((o) => o.value === next)?.label ?? next)}
      onQueryChange={setQuery}
      loading={loading}
      placeholder={placeholder}
      searchPlaceholder={placeholder}
      loadingText="Searching…"
      emptyText={failed ? "Search failed — edit the query to try again." : emptyText}
    />
  );
}
