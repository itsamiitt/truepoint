// AccountFilterPanel.tsx — the firmographic faceted filter sidebar (the Accounts sibling of FilterPanel.tsx),
// driving the server `AccountQuery` via the pure helpers in ../accountFilterGroups. Same design as FilterPanel:
// the firmographic groups are ACCORDIONS COLLAPSED BY DEFAULT (active-count badge per header), term facets use
// the PROGRESSIVE EXCLUDE pattern (see TermFacetField — include owns the full width, exclusion opens into its
// own labelled block), and the Prospect/Account scope switch is hosted at the top of the rail. Reuses
// FacetTypeahead for the high-cardinality facets that map onto a server FacetKey, and a free-text add for the
// account-only facets.
"use client";

import type { AccountQuery, AccountTermField, FacetKey } from "@leadwolf/types";
import { TpButton, TpInput } from "@leadwolf/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ACCOUNT_FILTER_GROUPS,
  type AccountFacetDef,
  type AccountFilterGroup,
  type TermOp,
  addTermCondition,
  clearAllFilters,
  getRange,
  groupActiveCount,
  hasActiveFilters,
  removeTermCondition,
  setRange,
  termConditions,
} from "../accountFilterGroups";
import { useDraftRange } from "../hooks/useDraftRange";
import styles from "../prospect.module.css";
import { FacetTypeahead } from "./FacetTypeahead";
import { TermFacetField } from "./TermFacetField";
import { TermOptionChips } from "./TermOptionChips";

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
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  const typeaheadKey = facet.input === "typeahead" ? TYPEAHEAD_FACET_KEY[facet.field] : undefined;
  // A value applied in EITHER direction is never offered again — it can never be both included and excluded.
  const options = (facet.options ?? []).filter((o) => !applied.has(o.value));
  const add = (op: TermOp, value: string) =>
    onChange(addTermCondition(query, facet.field, op, value));

  const picker = (op: TermOp, autoFocus: boolean) => {
    if (facet.input !== "typeahead")
      return (
        <TermOptionChips
          field={facet.field}
          options={options}
          op={op}
          counts={counts}
          anyApplied={applied.size > 0}
          onAdd={(v) => add(op, v)}
        />
      );
    return typeaheadKey ? (
      <FacetTypeahead
        field={typeaheadKey}
        label={facet.label}
        op={op}
        autoFocus={autoFocus}
        selected={[...applied]}
        onAdd={(v) => add(op, v)}
      />
    ) : (
      <FreeTextAdd label={facet.label} op={op} autoFocus={autoFocus} onAdd={(v) => add(op, v)} />
    );
  };

  return (
    <TermFacetField
      label={facet.label}
      conditions={conditions}
      excludeNoun="Accounts"
      onRemove={(op, value) => onChange(removeTermCondition(query, facet.field, op, value))}
      renderPicker={picker}
    />
  );
}

/** Free-text value add for account-only facets with no contacts-side typeahead index (hq_country/hq_city/…). */
function FreeTextAdd({
  label,
  op,
  autoFocus,
  onAdd,
}: {
  label: string;
  op: TermOp;
  autoFocus: boolean;
  onAdd: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  const commit = () => {
    const v = value.trim();
    if (v) onAdd(v);
    setValue("");
  };
  useEffect(() => {
    // TpInput renders a plain <input> and takes no ref, so reach it through the wrapper.
    if (autoFocus) anchorRef.current?.querySelector("input")?.focus();
  }, [autoFocus]);
  return (
    <div ref={anchorRef}>
      <TpInput
        value={value}
        aria-label={op === "exclude" ? `${label} to exclude` : `Add ${label.toLowerCase()}`}
        placeholder={op === "exclude" ? `${label} to exclude…` : `Add ${label.toLowerCase()}…`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
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
  // Same draft-buffer as the Contacts panel's RangeControl: the query is the cache key for the account search
  // (and its facet counts), so committing per keystroke fired several backend searches per character typed.
  const { draft, schedule, flush } = useDraftRange(gte, lte, (next) =>
    onChange(setRange(query, field, next.gte, next.lte)),
  );
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
          value={toInput(draft.gte)}
          onChange={(e) => schedule({ gte: fromInput(e.target.value), lte: draft.lte })}
          onBlur={flush}
        />
        <TpInput
          type="number"
          placeholder="Max"
          value={toInput(draft.lte)}
          onChange={(e) => schedule({ gte: draft.gte, lte: fromInput(e.target.value) })}
          onBlur={flush}
        />
      </div>
    </div>
  );
}

function facetKeyOf(facet: AccountFacetDef): string {
  return `${facet.kind}:${facet.field}`;
}
