// FilterPanel.tsx — the Apollo/ZoomInfo-style faceted filter sidebar (24 §2). Drives the server `ContactQuery`
// via the pure helpers in ../filterGroups. Design: the five FILTER_GROUPS are ACCORDIONS COLLAPSED BY DEFAULT
// (a count badge on each header keeps active filters discoverable while collapsed); a term facet uses the
// PROGRESSIVE EXCLUDE pattern (see TermFacetField) — include owns the full width, exclusion opens into its own
// labelled block, and both clauses coexist on the same field. Applied values live INLINE inside their own
// section (no separate chip row). The Prospect/Account scope switch is hosted here (top of the rail).
// Presentation only — the page owns query state, URL persistence, and counts.
"use client";

import type { BoolFilterField, ContactQuery } from "@leadwolf/types";
import { TpButton, TpChip, TpInput } from "@leadwolf/ui";
import { type ReactNode, useState } from "react";
import {
  FILTER_GROUPS,
  type FacetDef,
  type FilterGroup,
  type TermOp,
  addTermCondition,
  clearAllFilters,
  getBool,
  getRange,
  groupActiveCount,
  hasActiveFilters,
  removeTermCondition,
  setBool,
  setRange,
  termConditions,
} from "../filterGroups";
import { useDraftRange } from "../hooks/useDraftRange";
import styles from "../prospect.module.css";
import { FacetScopeBadge } from "./FacetScopeBadge";
import { FacetTypeahead } from "./FacetTypeahead";
import { TermFacetField } from "./TermFacetField";
import { TermOptionChips } from "./TermOptionChips";

export interface OwnerOption {
  value: string;
  label: string;
}

export function FilterPanel({
  query,
  onChange,
  counts,
  owners = [],
  header,
  scopeSwitch,
}: {
  query: ContactQuery;
  onChange: (next: ContactQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/facets). Optional. */
  counts?: Map<string, number>;
  /** Teammates (+ a "Me" entry the page prepends) for the Owner facet. */
  owners?: OwnerOption[];
  /** Optional rail content (saved + recent searches) rendered under the head, before the groups. */
  header?: ReactNode;
  /** The Prospect/Account scope switch, hosted at the top of the sidebar. */
  scopeSwitch?: ReactNode;
}) {
  return (
    <aside className={styles.rail} aria-label="Filters">
      {scopeSwitch != null ? <div className={styles.railScope}>{scopeSwitch}</div> : null}

      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <TpButton variant="ghost" size="sm" onClick={() => onChange(clearAllFilters(query))}>
            Clear all
          </TpButton>
        ) : null}
      </div>

      {header != null ? <div className={styles.railSection}>{header}</div> : null}

      {FILTER_GROUPS.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          query={query}
          onChange={onChange}
          counts={counts}
          owners={owners}
        />
      ))}
    </aside>
  );
}

// ── one accordion group (collapsed by default) ──────────────────────────────────────────────────────────
function GroupSection({
  group,
  query,
  onChange,
  counts,
  owners,
}: {
  group: FilterGroup;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  const [open, setOpen] = useState(false); // collapsed by default
  const activeCount = groupActiveCount(
    query,
    group.facets.map((f) => f.field),
  );

  return (
    <section className={styles.group}>
      {/* Raw <button>: an accordion section header, not an action button — full-bleed, justified, carrying a
          count badge and a chevron. No TpButton variant is that shape, and `tp-ui-btn` would impose its own
          height/padding. Accessible name comes from the visible title + badge. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={styles.groupHead}
      >
        <span className={styles.groupTitle}>
          {group.title}
          {activeCount > 0 ? <span className={styles.groupBadge}>{activeCount}</span> : null}
        </span>
        <span aria-hidden className={styles.groupChevron}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div className={styles.groupBody}>
          {group.facets.map((facet) => (
            <FacetControl
              key={facetKeyOf(facet)}
              facet={facet}
              query={query}
              onChange={onChange}
              counts={counts}
              owners={owners}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ── one facet control ───────────────────────────────────────────────────────────────────────────────────
function FacetControl({
  facet,
  query,
  onChange,
  counts,
  owners,
}: {
  facet: FacetDef;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  // Every control carries its own scope mark, so "this filter will not search the database" is visible
  // before the click rather than only in the notice above the grid afterwards.
  const scopeNote = <FacetScopeBadge scope={facet.scope} />;
  if (facet.kind === "bool")
    return (
      <BoolControl
        field={facet.field}
        label={facet.label}
        query={query}
        onChange={onChange}
        scopeNote={scopeNote}
      />
    );
  if (facet.kind === "range")
    return (
      <RangeControl
        field={facet.field}
        label={facet.label}
        valueKind={facet.valueKind}
        unit={facet.unit}
        query={query}
        onChange={onChange}
        scopeNote={scopeNote}
      />
    );
  return (
    <TermFacet
      facet={facet}
      query={query}
      onChange={onChange}
      counts={counts}
      owners={owners}
      scopeNote={scopeNote}
    />
  );
}

// ── term facet: progressive exclude (include by default; exclusion opens into its own block) ─────────────
function TermFacet({
  facet,
  query,
  onChange,
  counts,
  owners,
  scopeNote,
}: {
  facet: Extract<FacetDef, { kind: "term" }>;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
  scopeNote?: ReactNode;
}) {
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  // A value applied in EITHER direction is never offered again — it can never be both included and excluded.
  const options = (facet.input === "owner" ? owners : (facet.options ?? [])).filter(
    (o) => !applied.has(o.value),
  );
  const add = (op: TermOp, value: string) =>
    onChange(addTermCondition(query, facet.field, op, value));

  return (
    <TermFacetField
      label={facet.label}
      conditions={conditions}
      excludeNoun="Contacts"
      scopeNote={scopeNote}
      onRemove={(op, value) => onChange(removeTermCondition(query, facet.field, op, value))}
      renderPicker={(op, autoFocus) =>
        facet.input === "typeahead" ? (
          <FacetTypeahead
            field={facet.field}
            label={facet.label}
            // A database-only facet's values live in Layer-0, which the workspace suggest cannot see.
            source={facet.scope === "database-only" ? "database" : "workspace"}
            op={op}
            autoFocus={autoFocus}
            selected={[...applied]}
            onAdd={(v) => add(op, v)}
          />
        ) : (
          <TermOptionChips
            field={facet.field}
            options={options}
            op={op}
            counts={counts}
            anyApplied={applied.size > 0}
            onAdd={(v) => add(op, v)}
          />
        )
      }
    />
  );
}

/**
 * The Any/Yes/No pill for a bool facet — now the DS chip rather than a hand-rolled `.miniToggle`.
 *
 * TpChip and not SegmentedControl, even though a three-way single-select is what a radiogroup is for:
 * SegmentedControl swaps the keyboard model (roving tabindex, arrows move AND select) for one that these
 * pills never had, and `.tp-ui-segmented-item` paints --tp-ink-3 on --tp-surface-3 — 4.43:1, below AA, which
 * would be a new contrast failure introduced by the pass that exists to remove them. TpChip keeps the current
 * behaviour exactly (three independent tab stops, click to set) and its inactive pill is ink-2 on surface-3
 * at 9.45:1.
 */
function MiniToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TpChip active={active} onClick={onClick}>
      {children}
    </TpChip>
  );
}

function BoolControl({
  field,
  label,
  query,
  onChange,
  scopeNote,
}: {
  field: BoolFilterField;
  label: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  scopeNote?: ReactNode;
}) {
  const current = getBool(query, field);
  const opt = (value: boolean | undefined, text: string) => (
    <MiniToggle active={current === value} onClick={() => onChange(setBool(query, field, value))}>
      {text}
    </MiniToggle>
  );
  return (
    <div className={styles.facetRow}>
      <span className={styles.facetLabelRow}>
        <span className={styles.facetLabel}>{label}</span>
        {scopeNote}
      </span>
      <span className={styles.opToggle}>
        {opt(undefined, "Any")}
        {opt(true, "Yes")}
        {opt(false, "No")}
      </span>
    </div>
  );
}

function RangeControl({
  field,
  label,
  valueKind,
  unit,
  query,
  onChange,
  scopeNote,
}: {
  field: string;
  label: string;
  valueKind: "number" | "date";
  unit?: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  scopeNote?: ReactNode;
}) {
  const { gte, lte } = getRange(query, field);
  // Keystrokes land in a draft and commit after a quiet 400ms (or on blur) — the query is the cache key for
  // search + facets + count + database, so committing per keystroke fired 4-5 requests per character typed.
  const { draft, schedule, flush } = useDraftRange(gte, lte, (next) =>
    onChange(setRange(query, field, next.gte, next.lte)),
  );
  const toInput = (n: number | undefined) =>
    n === undefined ? "" : valueKind === "date" ? msToDateInput(n) : String(n);
  const fromInput = (s: string): number | undefined => {
    if (!s) return undefined;
    return valueKind === "date" ? dateInputToMs(s) : Number(s);
  };
  return (
    <div className={styles.facet}>
      <span className={styles.facetLabelRow}>
        <span className={styles.facetLabel}>
          {label}
          {unit ? ` (${unit})` : ""}
        </span>
        {scopeNote}
      </span>
      <div className={styles.rangeRow}>
        <TpInput
          type={valueKind === "date" ? "date" : "number"}
          placeholder="Min"
          value={toInput(draft.gte)}
          onChange={(e) => schedule({ gte: fromInput(e.target.value), lte: draft.lte })}
          onBlur={flush}
        />
        <TpInput
          type={valueKind === "date" ? "date" : "number"}
          placeholder="Max"
          value={toInput(draft.lte)}
          onChange={(e) => schedule({ gte: draft.gte, lte: fromInput(e.target.value) })}
          onBlur={flush}
        />
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
function facetKeyOf(facet: FacetDef): string {
  return `${facet.kind}:${facet.field}`;
}

/** epoch-ms → <input type=date> value (YYYY-MM-DD, UTC). */
function msToDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** <input type=date> value → epoch-ms at UTC midnight. */
function dateInputToMs(s: string): number {
  return new Date(`${s}T00:00:00.000Z`).getTime();
}
