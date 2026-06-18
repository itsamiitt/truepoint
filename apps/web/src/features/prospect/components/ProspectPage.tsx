// ProspectPage.tsx — the prospect master/detail surface (04 §5, 11 §4.2): a faceted filter rail, an active-
// filter summary, a Contacts⇄Accounts segmented control, the results DataTable (sortable, density-aware,
// masked email/phone glyphs + a row-select column), the record-detail Drawer, and a sticky bulk-action bar.
// Search is list-only at MVP (05 §5), so the rail filters the loaded rows client-side. This is the slice's
// public component (mounted by the thin (shell)/prospect route). Composition + view state; data + masking
// come from the slice.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  SegmentedControl,
  StateSwitch,
  Tooltip,
  TpButton,
  TpChip,
} from "@leadwolf/ui";
import { Building2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useBulkSelection } from "../hooks/useBulkSelection";
import { useContacts } from "../hooks/useContacts";
import { useTaggedIds, useTags } from "../hooks/useTags";
import styles from "../prospect.module.css";
import {
  EMPTY_FILTER,
  type ProspectFilter,
  type ResultScope,
  activeFilterChips,
  applyFilter,
  displayName,
  emailGlyphFor,
  isEmptyFilter,
  maskedEmail,
} from "../types";
import { BulkActionBar } from "./BulkActionBar";
import { FilterRail } from "./FilterRail";
import { RecordDetail } from "./RecordDetail";

const SCOPES = [
  { value: "contacts", label: "Contacts" },
  { value: "accounts", label: "Accounts" },
];

const DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

export function ProspectPage() {
  const { contacts, error, loading, reload, markRevealed } = useContacts();
  const { tags, reload: reloadTags } = useTags();
  const [filter, setFilter] = useState<ProspectFilter>(EMPTY_FILTER);
  const [scope, setScope] = useState<ResultScope>("contacts");
  const [density, setDensity] = useState("comfortable");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Filter-by-tag (ADR-0028, G-REV-6) is list-only: resolve the union of record ids carrying the selected
  // tags, then applyFilter narrows the loaded rows against it. tagNames labels the active-filter chips.
  const taggedIds = useTaggedIds(filter.tags);
  const tagNames = useMemo(() => Object.fromEntries(tags.map((t) => [t.id, t.name])), [tags]);

  const filtered = useMemo(
    () => applyFilter(contacts, filter, taggedIds),
    [contacts, filter, taggedIds],
  );
  const selected = useMemo(
    () => contacts.find((c) => c.id === selectedId) ?? null,
    [contacts, selectedId],
  );
  const chips = useMemo(() => activeFilterChips(filter, tagNames), [filter, tagNames]);

  // Multi-row selection for the bulk-action bar (distinct from the single-row Drawer selection above).
  const bulk = useBulkSelection();
  const shownIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => bulk.selectedIds.has(id));
  const selectedContacts = useMemo(
    () => contacts.filter((c) => bulk.selectedIds.has(c.id)),
    [contacts, bulk.selectedIds],
  );
  // Only contacts with a maskable email and not yet revealed can be bulk-revealed (07 §3).
  const revealableIds = useMemo(
    () => selectedContacts.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id),
    [selectedContacts],
  );

  const columns: Column<MaskedContact>[] = useMemo(
    () => [
      {
        key: "select",
        // The header checkbox selects/clears every visible row; click stays out of the row-open handler.
        header: (
          <span
            className={styles.headCheck}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <input
              type="checkbox"
              aria-label="Select all shown"
              checked={allShownSelected}
              onChange={(e) => bulk.setMany(shownIds, e.target.checked)}
            />
          </span>
        ),
        width: 36,
        cell: (c) => (
          <span
            className={styles.rowCheck}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <input
              type="checkbox"
              checked={bulk.isSelected(c.id)}
              onChange={() => bulk.toggle(c.id)}
              aria-label={`Select ${displayName(c)}`}
            />
          </span>
        ),
      },
      {
        key: "name",
        header: "Name",
        sortValue: (c) => displayName(c),
        cell: (c) => (
          <span className={styles.nameCell}>
            <span className={styles.nameMeta}>
              <span className={styles.name}>{displayName(c)}</span>
              <span className={styles.title}>{c.jobTitle ?? "—"}</span>
            </span>
          </span>
        ),
      },
      {
        key: "company",
        header: "Company",
        sortValue: (c) => c.emailDomain ?? "",
        cell: (c) => <span className={styles.mono}>{c.emailDomain ?? "—"}</span>,
      },
      {
        key: "email",
        header: "Email",
        align: "center",
        width: 56,
        sortValue: (c) => c.emailStatus,
        cell: (c) => {
          const g = emailGlyphFor(c);
          const cls =
            g.tone === "ok"
              ? styles.glyphOk
              : g.tone === "warn"
                ? styles.glyphWarn
                : styles.glyphNone;
          return (
            <Tooltip label={g.label}>
              <span className={`${styles.glyph} ${cls}`} aria-label={g.label}>
                {g.mark}
              </span>
            </Tooltip>
          );
        },
      },
      {
        key: "address",
        header: "Address",
        cell: (c) => <span className={styles.mono}>{maskedEmail(c)}</span>,
      },
      {
        key: "phone",
        header: "Phone",
        align: "center",
        width: 64,
        sortValue: (c) => (c.hasPhone ? 1 : 0),
        cell: (c) =>
          c.hasPhone ? (
            <Tooltip label="Phone hidden until reveal">
              <span className={styles.lock} aria-label="Phone hidden until reveal">
                🔒
              </span>
            </Tooltip>
          ) : (
            <span className={styles.glyphNone}>—</span>
          ),
      },
    ],
    [allShownSelected, shownIds, bulk],
  );

  return (
    <div className={styles.page} data-density={density}>
      <FilterRail filter={filter} onChange={setFilter} contacts={contacts} tags={tags} />

      <section className={styles.results}>
        <div className={styles.resultsHead}>
          <div className={styles.headLeft}>
            <SegmentedControl
              items={SCOPES}
              value={scope}
              onChange={(v) => setScope(v as ResultScope)}
              aria-label="Result type"
            />
            {scope === "contacts" && (
              <span className={styles.count}>
                {loading
                  ? "Loading…"
                  : `${filtered.length.toLocaleString()} of ${contacts.length.toLocaleString()}`}
              </span>
            )}
          </div>
          <div className={styles.headRight}>
            <SegmentedControl
              items={DENSITIES}
              value={density}
              onChange={setDensity}
              aria-label="Row density"
            />
          </div>
        </div>

        {scope === "contacts" && !isEmptyFilter(filter) && (
          <div className={styles.summary}>
            <span className={styles.summaryLabel}>Filters</span>
            {chips.map((chip) => (
              <TpChip key={chip.key} onRemove={() => setFilter((f) => chip.clear(f))}>
                {chip.label}
              </TpChip>
            ))}
            <span className={styles.summarySpacer} />
            <TpButton variant="link" size="sm" onClick={() => setFilter(EMPTY_FILTER)}>
              Clear all
            </TpButton>
          </div>
        )}

        {scope === "accounts" ? (
          <EmptyState
            icon={<Building2 size={28} />}
            title="Accounts view is coming"
            description="The account-level rollup of your prospects lands in a later milestone. Switch back to Contacts to work the list."
          />
        ) : (
          <StateSwitch
            loading={loading}
            error={error}
            empty={!loading && contacts.length === 0}
            onRetry={reload}
            emptyState={
              <EmptyState
                icon={<Users size={28} />}
                title="No contacts yet"
                description="Import a CSV from the Import surface to populate this workspace, then prospect, score and reveal here."
              />
            }
          >
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(c) => c.id}
              onRowClick={(c) => setSelectedId(c.id)}
              isSelected={(c) => c.id === selectedId}
              empty={
                <EmptyState
                  title="No matches"
                  description="No contacts match these filters."
                  action={
                    <TpButton variant="secondary" size="sm" onClick={() => setFilter(EMPTY_FILTER)}>
                      Clear filters
                    </TpButton>
                  }
                />
              }
            />
          </StateSwitch>
        )}
      </section>

      <RecordDetail
        contact={selected}
        onClose={() => setSelectedId(null)}
        onRevealed={(id) => markRevealed(id)}
        onTagsChanged={reloadTags}
      />

      {bulk.count > 0 && (
        <BulkActionBar
          count={bulk.count}
          selectedContacts={selectedContacts}
          revealableIds={revealableIds}
          onClear={bulk.clear}
          onRevealed={(ids) => {
            for (const id of ids) markRevealed(id);
            bulk.clear();
          }}
        />
      )}
    </div>
  );
}
