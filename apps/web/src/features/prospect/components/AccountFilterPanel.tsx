// AccountFilterPanel.tsx — the firmographic faceted filter sidebar (the Accounts sibling of FilterPanel.tsx),
// driving the server `AccountQuery` directly via the pure helpers in ../accountFilterGroups (multi-select within
// a facet = OR, across facets = AND, include/exclude give negative filters). Renders the five collapsible
// firmographic groups from ACCOUNT_FILTER_GROUPS; reuses FacetTypeahead for the high-cardinality facets that map
// onto a server FacetKey, and a free-text add for the account-only facets (sub_industry / hq_country / hq_city)
// that have no contacts-side typeahead index. Shows live per-option counts when the page supplies them. Removable
// pills (activeChips) + clear-all sit at the top. Presentation only — the page owns the query state + the URL.
"use client";

import type { AccountQuery, AccountTermField, FacetKey } from "@leadwolf/types";
import { TpChip, TpInput } from "@leadwolf/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import {
  ACCOUNT_FILTER_GROUPS,
  type AccountFacetDef,
  type TermOp,
  activeChips,
  clearAllFilters,
  getRange,
  getTermValues,
  hasActiveFilters,
  setRange,
  toggleTermValue,
} from "../accountFilterGroups";
import styles from "../prospect.module.css";
import { FacetTypeahead } from "./FacetTypeahead";

// Account term fields that ALSO exist on the contacts-side FacetKey index → reuse the server typeahead.
const TYPEAHEAD_FACET_KEY: Partial<Record<AccountTermField, FacetKey>> = {
  industry: "industry",
  technology: "technology",
};

export function AccountFilterPanel({
  query,
  onChange,
  counts,
}: {
  query: AccountQuery;
  onChange: (next: AccountQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/accounts/facets). Optional. */
  counts?: Map<string, number>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ops, setOps] = useState<Record<string, TermOp>>({});
  const chips = activeChips(query);

  return (
    <aside className={styles.rail} aria-label="Company filters">
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

      {ACCOUNT_FILTER_GROUPS.map((group) => {
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
}: {
  facet: AccountFacetDef;
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
  op: TermOp;
  onOpChange: (op: TermOp) => void;
  counts?: Map<string, number>;
}) {
  if (facet.kind === "range")
    return (
      <RangeControl
        field={facet.field}
        label={facet.label}
        unit={facet.unit}
        query={query}
        onChange={onChange}
      />
    );

  // term facet: an Is / Is not op toggle + the value picker for that op.
  const selected = getTermValues(query, facet.field, op);
  const typeaheadKey = facet.input === "typeahead" ? TYPEAHEAD_FACET_KEY[facet.field] : undefined;

  return (
    <div className={styles.facet}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span className={styles.facetLabel}>{facet.label}</span>
        <OpToggle op={op} onChange={onOpChange} />
      </div>
      {facet.input === "typeahead" ? (
        typeaheadKey ? (
          <FacetTypeahead
            field={typeaheadKey}
            label={facet.label}
            selected={selected}
            onAdd={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
            onRemove={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
          />
        ) : (
          <FreeTextAdd
            label={facet.label}
            selected={selected}
            onAdd={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
            onRemove={(v) => onChange(toggleTermValue(query, facet.field, op, v))}
          />
        )
      ) : (
        <div className={styles.chipWrap}>
          {(facet.options ?? []).length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>No options</span>
          ) : (
            (facet.options ?? []).map((o) => {
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

/** Free-text value add for account-only facets with no contacts-side typeahead index (hq_country/hq_city/…). */
function FreeTextAdd({
  label,
  selected,
  onAdd,
  onRemove,
}: {
  label: string;
  selected: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const commit = () => {
    const v = value.trim();
    if (v) onAdd(v);
    setValue("");
  };
  return (
    <div style={{ display: "block" }}>
      <TpInput
        value={value}
        placeholder={`Add ${label.toLowerCase()}…`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
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
        color: active ? "var(--tp-surface)" : "var(--tp-ink-3)",
      }}
    >
      {children}
    </button>
  );
}

function RangeControl({
  field,
  label,
  unit,
  query,
  onChange,
}: {
  field: string;
  label: string;
  unit?: string;
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
}) {
  const { gte, lte } = getRange(query, field);
  const toInput = (n: number | undefined) => (n === undefined ? "" : String(n));
  const fromInput = (s: string): number | undefined => (s ? Number(s) : undefined);
  return (
    <div className={styles.facet}>
      <span className={styles.facetLabel}>
        {label}
        {unit ? ` (${unit})` : ""}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <TpInput
          type="number"
          placeholder="Min"
          value={toInput(gte)}
          onChange={(e) => onChange(setRange(query, field, fromInput(e.target.value), lte))}
        />
        <TpInput
          type="number"
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

function facetKeyOf(facet: AccountFacetDef): string {
  return `${facet.kind}:${facet.field}`;
}
