// FilterPanel.tsx — the Apollo/ZoomInfo-style faceted filter sidebar (24 §2). Drives the server `ContactQuery`
// via the pure helpers in ../filterGroups. Design: the five FILTER_GROUPS are ACCORDIONS COLLAPSED BY DEFAULT
// (a count badge on each header keeps active filters discoverable while collapsed); a term facet supports the
// full is/is-not MULTI-CONDITION pattern — each condition renders as its own inline tag (its type flips on
// click, ✕ removes), and a value picker + an is/is-not add-type toggle add new ones. Applied tags live INLINE
// inside their own section (no separate chip row). The Prospect/Account scope switch is hosted here (top of the
// rail). Presentation only — the page owns query state, URL persistence, and counts.
"use client";

import type { BoolFilterField, ContactQuery } from "@leadwolf/types";
import { TpButton, TpInput } from "@leadwolf/ui";
import { type ReactNode, useState } from "react";
import {
  FILTER_GROUPS,
  type FacetDef,
  type FilterGroup,
  type TermOp,
  addTermCondition,
  clearAllFilters,
  flipTermCondition,
  getBool,
  getRange,
  groupActiveCount,
  hasActiveFilters,
  removeTermCondition,
  setBool,
  setRange,
  termConditions,
} from "../filterGroups";
import styles from "../prospect.module.css";
import { FacetTypeahead } from "./FacetTypeahead";

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
  if (facet.kind === "bool")
    return (
      <BoolControl field={facet.field} label={facet.label} query={query} onChange={onChange} />
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
      />
    );
  return (
    <TermFacet facet={facet} query={query} onChange={onChange} counts={counts} owners={owners} />
  );
}

// ── term facet: multi-condition (is / is not), each condition an independent inline tag ──────────────────
function TermFacet({
  facet,
  query,
  onChange,
  counts,
  owners,
}: {
  facet: Extract<FacetDef, { kind: "term" }>;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  // The type a newly-picked value is added as. Each value is single-typed; this only controls NEW additions.
  const [addOp, setAddOp] = useState<TermOp>("include");
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  const options = (facet.input === "owner" ? owners : (facet.options ?? [])).filter(
    (o) => !applied.has(o.value),
  );

  return (
    <div className={styles.facet}>
      <span className={styles.facetLabel}>{facet.label}</span>

      {conditions.length > 0 ? (
        <div className={styles.condList}>
          {conditions.map((c) => (
            <span key={`${c.op}:${c.value}`} className={styles.condTag}>
              <button
                type="button"
                className={styles.condType}
                data-op={c.op}
                title="Toggle is / is not"
                onClick={() => onChange(flipTermCondition(query, facet.field, c.op, c.value))}
              >
                {c.op === "include" ? "is" : "is not"}
              </button>
              <span className={styles.condValue}>{c.label}</span>
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                className={styles.condRemove}
                onClick={() => onChange(removeTermCondition(query, facet.field, c.op, c.value))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.addRow}>
        <OpToggle op={addOp} onChange={setAddOp} />
        {facet.input === "typeahead" ? (
          <FacetTypeahead
            field={facet.field}
            label={facet.label}
            selected={[...applied]}
            onAdd={(v) => onChange(addTermCondition(query, facet.field, addOp, v))}
            onRemove={(v) => onChange(removeTermCondition(query, facet.field, "include", v))}
          />
        ) : null}
      </div>

      {facet.input !== "typeahead" ? (
        <div className={styles.chipWrap}>
          {options.length === 0 ? (
            <span className={styles.facetEmpty}>
              {applied.size > 0 ? "All options selected" : "No options"}
            </span>
          ) : (
            options.map((o) => {
              const count = counts?.get(`${facet.field}:${o.value}`);
              return (
                <button
                  key={o.value}
                  type="button"
                  className={styles.addChip}
                  onClick={() => onChange(addTermCondition(query, facet.field, addOp, o.value))}
                >
                  + {o.label}
                  {count !== undefined ? ` (${count.toLocaleString()})` : ""}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function OpToggle({ op, onChange }: { op: TermOp; onChange: (op: TermOp) => void }) {
  return (
    <span className={styles.opToggle}>
      <MiniToggle active={op === "include"} onClick={() => onChange("include")}>
        is
      </MiniToggle>
      <MiniToggle active={op === "exclude"} onClick={() => onChange("exclude")}>
        is not
      </MiniToggle>
    </span>
  );
}

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
    <button
      type="button"
      onClick={onClick}
      className={styles.miniToggle}
      data-active={active ? "true" : undefined}
    >
      {children}
    </button>
  );
}

function BoolControl({
  field,
  label,
  query,
  onChange,
}: {
  field: BoolFilterField;
  label: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
}) {
  const current = getBool(query, field);
  const opt = (value: boolean | undefined, text: string) => (
    <MiniToggle active={current === value} onClick={() => onChange(setBool(query, field, value))}>
      {text}
    </MiniToggle>
  );
  return (
    <div className={styles.facetRow}>
      <span className={styles.facetLabel}>{label}</span>
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
}: {
  field: string;
  label: string;
  valueKind: "number" | "date";
  unit?: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
}) {
  const { gte, lte } = getRange(query, field);
  const toInput = (n: number | undefined) =>
    n === undefined ? "" : valueKind === "date" ? msToDateInput(n) : String(n);
  const fromInput = (s: string): number | undefined => {
    if (!s) return undefined;
    return valueKind === "date" ? dateInputToMs(s) : Number(s);
  };
  return (
    <div className={styles.facet}>
      <span className={styles.facetLabel}>
        {label}
        {unit ? ` (${unit})` : ""}
      </span>
      <div className={styles.rangeRow}>
        <TpInput
          type={valueKind === "date" ? "date" : "number"}
          placeholder="Min"
          value={toInput(gte)}
          onChange={(e) => onChange(setRange(query, field, fromInput(e.target.value), lte))}
        />
        <TpInput
          type={valueKind === "date" ? "date" : "number"}
          placeholder="Max"
          value={toInput(lte)}
          onChange={(e) => onChange(setRange(query, field, gte, fromInput(e.target.value)))}
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
