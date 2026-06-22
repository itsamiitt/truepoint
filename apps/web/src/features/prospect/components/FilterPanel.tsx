// FilterPanel.tsx — the Apollo/ZoomInfo-style faceted filter sidebar (24 §2), rebuilt to drive the server
// `ContactQuery` directly via the pure helpers in ../filterGroups (so multi-select within a facet = OR, across
// facets = AND, and include/exclude give negative filters). Renders the five collapsible groups from
// FILTER_GROUPS; reuses FacetTypeahead for high-cardinality facets and shows live per-option counts when the
// page supplies them. Removable pills (activeChips) + clear-all sit at the top. Presentation only — the page
// owns the query state, persists it to the URL (searchUrlState), and fetches counts. Not wired into
// ProspectPage yet (that swap lands next, preserving the existing bulk/detail wiring).
"use client";

import type { BoolFilterField, ContactQuery } from "@leadwolf/types";
import { TpChip, TpInput } from "@leadwolf/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import {
  FILTER_GROUPS,
  type FacetDef,
  type TermOp,
  activeChips,
  clearAllFilters,
  getBool,
  getRange,
  getTermValues,
  hasActiveFilters,
  setBool,
  setRange,
  toggleTermValue,
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
}: {
  query: ContactQuery;
  onChange: (next: ContactQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/facets). Optional. */
  counts?: Map<string, number>;
  /** Teammates (+ a "Me" entry the page prepends) for the Owner facet. */
  owners?: OwnerOption[];
  /** Optional rail content (saved + recent searches) rendered after the active-filter pills, before groups. */
  header?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ops, setOps] = useState<Record<string, TermOp>>({});
  const chips = activeChips(query);

  return (
    <aside className={styles.rail} aria-label="Filters">
      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <button
            type="button"
            className="tp-ui-btn tp-ui-btn--ghost tp-ui-btn--sm"
            onClick={() => onChange(clearAllFilters(query))}
          >
            Clear all
          </button>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className={styles.chipWrap} style={{ marginBottom: 14 }}>
          {chips.map((c) => (
            <TpChip key={c.id} onRemove={() => onChange(c.remove(query))}>
              {c.label}
            </TpChip>
          ))}
        </div>
      ) : null}

      {header != null ? <div className={styles.railSection}>{header}</div> : null}

      {FILTER_GROUPS.map((group) => {
        const isCollapsed = collapsed[group.id] ?? false;
        return (
          <section key={group.id} style={{ borderTop: "1px solid var(--tp-hairline)" }}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((s) => ({ ...s, [group.id]: !isCollapsed }))}
              style={groupHeadStyle}
            >
              <span>{group.title}</span>
              <span aria-hidden style={{ color: "var(--tp-ink-4)" }}>
                {isCollapsed ? "+" : "−"}
              </span>
            </button>
            {!isCollapsed ? (
              <div style={{ paddingBottom: 12, display: "flex", flexDirection: "column", gap: 14 }}>
                {group.facets.map((facet) => (
                  <FacetControl
                    key={facetKeyOf(facet)}
                    facet={facet}
                    query={query}
                    onChange={onChange}
                    op={facet.kind === "term" ? (ops[facet.field] ?? "include") : "include"}
                    onOpChange={(o) =>
                      facet.kind === "term" && setOps((s) => ({ ...s, [facet.field]: o }))
                    }
                    counts={counts}
                    owners={owners}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </aside>
  );
}

// ── one facet control ───────────────────────────────────────────────────────────────────────────────────
function FacetControl({
  facet,
  query,
  onChange,
  op,
  onOpChange,
  counts,
  owners,
}: {
  facet: FacetDef;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  op: TermOp;
  onOpChange: (op: TermOp) => void;
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

  // term facet: an Is / Is not op toggle + the value picker for that op.
  const selected = getTermValues(query, facet.field, op);
  const options = facet.input === "owner" ? owners : (facet.options ?? []);

  return (
    <div className={styles.facet}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span className={styles.facetLabel}>{facet.label}</span>
        <OpToggle op={op} onChange={onOpChange} />
      </div>
      {facet.input === "typeahead" ? (
        <FacetTypeahead
          field={facet.field}
          label={facet.label}
          selected={selected}
          onAdd={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
          onRemove={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
        />
      ) : (
        <div className={styles.chipWrap}>
          {options.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>No options</span>
          ) : (
            options.map((o) => {
              const count = counts?.get(`${facet.field}:${o.value}`);
              return (
                <TpChip
                  key={o.value}
                  active={selected.includes(o.value)}
                  onClick={() => onChange(toggleTermValue(query, facet.field, op, o.value))}
                >
                  {o.label}
                  {count !== undefined ? ` (${count.toLocaleString()})` : ""}
                </TpChip>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function OpToggle({ op, onChange }: { op: TermOp; onChange: (op: TermOp) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
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
      style={{
        font: "inherit",
        fontSize: 11,
        padding: "1px 7px",
        borderRadius: 999,
        cursor: "pointer",
        border: "1px solid var(--tp-hairline-2)",
        background: active ? "var(--tp-ink)" : "var(--tp-surface)",
        color: active ? "#fff" : "var(--tp-ink-3)",
      }}
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
    <div className={styles.facet}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span className={styles.facetLabel}>{label}</span>
        <span style={{ display: "inline-flex", gap: 4 }}>
          {opt(undefined, "Any")}
          {opt(true, "Yes")}
          {opt(false, "No")}
        </span>
      </div>
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
      <div style={{ display: "flex", gap: 8 }}>
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
const groupHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "12px 0",
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--tp-ink)",
  background: "none",
  border: 0,
  cursor: "pointer",
};

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
