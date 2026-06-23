// AccountFilterPanel.tsx — the firmographic faceted filter sidebar (the Accounts sibling of FilterPanel.tsx),
// driving the server `AccountQuery` via the pure helpers in ../accountFilterGroups. Same design as FilterPanel:
// the firmographic groups are ACCORDIONS COLLAPSED BY DEFAULT (active-count badge per header), term facets
// support the is/is-not MULTI-CONDITION pattern (each condition an independent inline tag, flips on click, ✕
// removes), and the Prospect/Account scope switch is hosted at the top of the rail. Reuses FacetTypeahead for
// the high-cardinality facets that map onto a server FacetKey, and a free-text add for the account-only facets.
"use client";

import type { AccountQuery, AccountTermField, FacetKey } from "@leadwolf/types";
import { TpButton, TpInput } from "@leadwolf/ui";
import { type ReactNode, useState } from "react";
import {
  ACCOUNT_FILTER_GROUPS,
  type AccountFacetDef,
  type AccountFilterGroup,
  type TermOp,
  addTermCondition,
  clearAllFilters,
  flipTermCondition,
  getRange,
  groupActiveCount,
  hasActiveFilters,
  removeTermCondition,
  setRange,
  termConditions,
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
  scopeSwitch,
}: {
  query: AccountQuery;
  onChange: (next: AccountQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/accounts/facets). Optional. */
  counts?: Map<string, number>;
  /** The Prospect/Account scope switch, hosted at the top of the sidebar. */
  scopeSwitch?: ReactNode;
}) {
  return (
    <aside className={styles.rail} aria-label="Company filters">
      {scopeSwitch != null ? <div className={styles.railScope}>{scopeSwitch}</div> : null}

      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
        {hasActiveFilters(query) ? (
          <TpButton variant="ghost" size="sm" onClick={() => onChange(clearAllFilters(query))}>
            Clear all
          </TpButton>
        ) : null}
      </div>

      {ACCOUNT_FILTER_GROUPS.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          query={query}
          onChange={onChange}
          counts={counts}
        />
      ))}
    </aside>
  );
}

function GroupSection({
  group,
  query,
  onChange,
  counts,
}: {
  group: AccountFilterGroup;
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
  counts?: Map<string, number>;
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
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function FacetControl({
  facet,
  query,
  onChange,
  counts,
}: {
  facet: AccountFacetDef;
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
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
  return <TermFacet facet={facet} query={query} onChange={onChange} counts={counts} />;
}

function TermFacet({
  facet,
  query,
  onChange,
  counts,
}: {
  facet: Extract<AccountFacetDef, { kind: "term" }>;
  query: AccountQuery;
  onChange: (q: AccountQuery) => void;
  counts?: Map<string, number>;
}) {
  const [addOp, setAddOp] = useState<TermOp>("include");
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  const typeaheadKey = facet.input === "typeahead" ? TYPEAHEAD_FACET_KEY[facet.field] : undefined;
  const options = (facet.options ?? []).filter((o) => !applied.has(o.value));

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
          typeaheadKey ? (
            <FacetTypeahead
              field={typeaheadKey}
              label={facet.label}
              selected={[...applied]}
              onAdd={(v) => onChange(addTermCondition(query, facet.field, addOp, v))}
              onRemove={(v) => onChange(removeTermCondition(query, facet.field, "include", v))}
            />
          ) : (
            <FreeTextAdd
              label={facet.label}
              onAdd={(v) => onChange(addTermCondition(query, facet.field, addOp, v))}
            />
          )
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

/** Free-text value add for account-only facets with no contacts-side typeahead index (hq_country/hq_city/…). */
function FreeTextAdd({ label, onAdd }: { label: string; onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  const commit = () => {
    const v = value.trim();
    if (v) onAdd(v);
    setValue("");
  };
  return (
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
      <div className={styles.rangeRow}>
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

function facetKeyOf(facet: AccountFacetDef): string {
  return `${facet.kind}:${facet.field}`;
}
