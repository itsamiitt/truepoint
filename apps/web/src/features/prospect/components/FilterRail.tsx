// FilterRail.tsx — the faceted filter rail for the prospect surface (04 §5, 24 §2). Multi-select facets render
// as toggleable TpChips; high-cardinality facets (department, country) use the searchable Combobox over the
// loaded rows' distinct values; has-email/has-phone are TpCheckboxes. Search is list-only at MVP (05 §5) so
// every facet filters the already-loaded rows client-side (types.applyFilter). Composition + view state only.
"use client";

import type { ContactQuery, MaskedContact } from "@leadwolf/types";
import type { MaskedContact, Tag } from "@leadwolf/types";
import { Combobox, FieldGroup, TpCheckbox, TpChip, TpInput } from "@leadwolf/ui";
import { useMemo } from "react";
import styles from "../prospect.module.css";
import {
  EMAIL_STATUS_OPTIONS,
  OUTREACH_STATUS_OPTIONS,
  type ProspectFilter,
  SENIORITY_OPTIONS,
  distinctValues,
  toggleFacet,
} from "../types";
import { AiSearchBox } from "./AiSearchBox";
import { TagChip } from "./TagChip";

export function FilterRail({
  filter,
  onChange,
  contacts,
  onAiApply,
  tags = [],
}: {
  filter: ProspectFilter;
  onChange: (next: ProspectFilter) => void;
  /** The loaded rows — facet value sets (department, country) are derived from these (05 §5). */
  contacts: MaskedContact[];
  /**
   * Apply a VALIDATED filter compiled by the AI NL box (23, ADR-0023). Wired by the page to
   * useContactSearch setText/setFilters. Optional so the rail still renders where AI isn't wired.
   */
  onAiApply?: (query: ContactQuery) => void;
  /** The workspace's tags (ADR-0028, G-REV-6) — rendered as toggleable filter facets. */
  tags?: Tag[];
}) {
  const departments = useMemo(
    () => distinctValues(contacts, (c) => c.department).map((v) => ({ value: v, label: v })),
    [contacts],
  );
  const countries = useMemo(
    () => distinctValues(contacts, (c) => c.locationCountry).map((v) => ({ value: v, label: v })),
    [contacts],
  );
  return (
    <aside className={styles.rail} aria-label="Filters">
      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>Filters</h2>
      </div>

      {onAiApply ? (
        <FieldGroup label="Ask AI">
          <AiSearchBox onApply={onAiApply} />
        </FieldGroup>
      ) : null}

      <FieldGroup label="Search" htmlFor="tp-f-query">
        <TpInput
          id="tp-f-query"
          type="search"
          placeholder="Title, name, department…"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      </FieldGroup>

      <div className={styles.facet}>
        <span className={styles.facetLabel}>Seniority</span>
        <div className={styles.chipWrap}>
          {SENIORITY_OPTIONS.map((o) => (
            <TpChip
              key={o.value}
              active={filter.seniority.includes(o.value)}
              onClick={() =>
                onChange({ ...filter, seniority: toggleFacet(filter.seniority, o.value) })
              }
            >
              {o.label}
            </TpChip>
          ))}
        </div>
      </div>

      <div className={styles.facet}>
        <span className={styles.facetLabel}>Email status</span>
        <div className={styles.chipWrap}>
          {EMAIL_STATUS_OPTIONS.map((o) => (
            <TpChip
              key={o.value}
              active={filter.emailStatus.includes(o.value)}
              onClick={() =>
                onChange({ ...filter, emailStatus: toggleFacet(filter.emailStatus, o.value) })
              }
            >
              {o.label}
            </TpChip>
          ))}
        </div>
      </div>

      <div className={styles.facet}>
        <span className={styles.facetLabel}>Outreach</span>
        <div className={styles.chipWrap}>
          {OUTREACH_STATUS_OPTIONS.map((o) => (
            <TpChip
              key={o.value}
              active={filter.outreachStatus.includes(o.value)}
              onClick={() =>
                onChange({ ...filter, outreachStatus: toggleFacet(filter.outreachStatus, o.value) })
              }
            >
              {o.label}
            </TpChip>
          ))}
        </div>
      </div>

      {tags.length > 0 && (
        <div className={styles.facet}>
          <span className={styles.facetLabel}>Tags</span>
          <div className={styles.chipWrap}>
            {tags.map((t) => (
              <TagChip
                key={t.id}
                name={t.name}
                color={t.color}
                active={filter.tags.includes(t.id)}
                onClick={() => onChange({ ...filter, tags: toggleFacet(filter.tags, t.id) })}
              />
            ))}
          </div>
        </div>
      )}

      <div className={styles.facet}>
        <span className={styles.facetLabel}>Department</span>
        <Combobox
          options={departments}
          value={filter.department}
          onChange={(v) => onChange({ ...filter, department: v })}
          placeholder="Any department"
          searchPlaceholder="Search departments…"
          emptyText={departments.length === 0 ? "None in view" : "No matches"}
        />
      </div>

      <div className={styles.facet}>
        <span className={styles.facetLabel}>Country</span>
        <Combobox
          options={countries}
          value={filter.country}
          onChange={(v) => onChange({ ...filter, country: v })}
          placeholder="Any country"
          searchPlaceholder="Search countries…"
          emptyText={countries.length === 0 ? "None in view" : "No matches"}
        />
      </div>

      <div className={styles.checkRow}>
        <TpCheckbox
          label="Has email"
          checked={filter.hasEmail}
          onChange={(e) => onChange({ ...filter, hasEmail: e.target.checked })}
        />
        <TpCheckbox
          label="Has phone"
          checked={filter.hasPhone}
          onChange={(e) => onChange({ ...filter, hasPhone: e.target.checked })}
        />
      </div>
    </aside>
  );
}
