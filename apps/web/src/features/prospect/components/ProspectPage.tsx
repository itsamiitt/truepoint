// ProspectPage.tsx — the prospect master/detail surface (04 §5, 11 §4.2, 24): a faceted FilterPanel rail
// (now also hosting Saved + Recent searches in its header slot) driving a server ContactQuery, a top search
// box + AI NL box, a results header with a sort + column-chooser toolbar, the results table (sortable,
// density-aware, masked glyphs, row-select, per-row overflow menu) with a list⇄card toggle and keyset "Load
// more", a lightweight QuickView preview Drawer that hands off to the heavy RecordDetail, and the sticky
// bulk-action bar (the full Phase-3 bulk surface). Search/filter state lives in the URL (useProspectSearch →
// searchUrlState), so a view is shareable and restored on refresh/back. Composition + view state; data +
// masking + all mutations come from the slice (api/bulkActionsApi).
"use client";

import type { ContactHit, ContactQuery, FacetKey, MaskedContact } from "@leadwolf/types";
import {
  Avatar,
  type Column,
  DataTable,
  EmptyState,
  SegmentedControl,
  StateSwitch,
  Tooltip,
  TpButton,
  TpInput,
} from "@leadwolf/ui";
import { Building2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBulkSelection } from "../hooks/useBulkSelection";
import { useFacetCounts } from "../hooks/useFacetCounts";
import { useProspectSearch } from "../hooks/useProspectSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { useTags } from "../hooks/useTags";
import styles from "../prospect.module.css";
import { type ResultScope, displayName, emailGlyphFor, maskedEmail } from "../types";
import { AiSearchBox } from "./AiSearchBox";
import { BulkActionBar, type RowBulkAction } from "./BulkActionBar";
import { FilterPanel } from "./FilterPanel";
import { ProspectToolbar } from "./ProspectToolbar";
import { QuickViewDrawer } from "./QuickViewDrawer";
import { RecentSearches } from "./RecentSearches";
import { RecordDetail } from "./RecordDetail";
import { RowActions } from "./RowActions";
import { SaveSearchPanel } from "./SaveSearchPanel";

const SCOPES = [
  { value: "contacts", label: "Contacts" },
  { value: "accounts", label: "Accounts" },
];
const DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
const VIEWS = [
  { value: "list", label: "List" },
  { value: "card", label: "Cards" },
];
// The fixed-option facets that get live counts in the sidebar (POST /search/facets).
const COUNT_FIELDS: FacetKey[] = ["seniority", "outreach_status", "email_status", "source"];

// The toggleable result columns (the "select" checkbox + "actions" menu are always shown, not toggleable).
const TOGGLEABLE_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "phone", label: "Phone" },
];
const DEFAULT_VISIBLE = TOGGLEABLE_COLUMNS.map((c) => c.key);

export function ProspectPage() {
  const search = useProspectSearch();
  const {
    query,
    view,
    setQuery,
    setView,
    hits,
    loading,
    error,
    hasMore,
    loadMore,
    reload,
    markRevealed,
  } = search;
  const counts = useFacetCounts(query, COUNT_FIELDS);
  const recent = useRecentSearches();
  const { tags } = useTags();

  const [scope, setScope] = useState<ResultScope>("contacts");
  const [density, setDensity] = useState("comfortable");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE);
  // A pending row-level bulk action: the single id to seed + which bulk dialog to open.
  const [rowAction, setRowAction] = useState<RowBulkAction | null>(null);

  // Top free-text box: a local mirror committed to the query after a short debounce (typeahead feel), and
  // re-synced when the query changes externally (AI apply / URL restore).
  const [textInput, setTextInput] = useState(query.text ?? "");
  useEffect(() => setTextInput(query.text ?? ""), [query.text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce-commit keyed on the local input.
  useEffect(() => {
    const t = textInput.trim();
    if (t === (query.text ?? "")) return;
    const id = setTimeout(() => setQuery({ ...query, text: t || undefined }), 300);
    return () => clearTimeout(id);
  }, [textInput]);

  // Record each committed query into the per-browser recents (the hook dedupes + ignores empty queries).
  // biome-ignore lint/correctness/useExhaustiveDependencies: record only when the query identity changes.
  useEffect(() => {
    recent.add(query);
  }, [query]);

  const selected = useMemo(() => hits.find((c) => c.id === selectedId) ?? null, [hits, selectedId]);
  const preview = useMemo(() => hits.find((c) => c.id === previewId) ?? null, [hits, previewId]);

  // Multi-row selection for the bulk-action bar (distinct from the single-row Drawer selection).
  const bulk = useBulkSelection();
  const shownIds = useMemo(() => hits.map((c) => c.id), [hits]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => bulk.selectedIds.has(id));
  const selectedContacts = useMemo(
    () => hits.filter((c) => bulk.selectedIds.has(c.id)),
    [hits, bulk.selectedIds],
  );
  const revealableIds = useMemo(
    () => selectedContacts.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id),
    [selectedContacts],
  );

  // Seed the bulk selection to a single row, then ask the bar to open the matching dialog.
  const startRowAction = useCallback(
    (id: string, action: RowBulkAction) => {
      bulk.clear();
      bulk.setMany([id], true);
      setRowAction(action);
    },
    [bulk.clear, bulk.setMany],
  );

  const allColumns: Column<ContactHit>[] = useMemo(
    () => [
      {
        key: "select",
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
      {
        key: "actions",
        header: "",
        align: "right",
        width: 48,
        cell: (c) => (
          <span
            className={styles.rowCheck}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <RowActions
              contact={c}
              onAddToList={() => startRowAction(c.id, "list")}
              onTag={() => startRowAction(c.id, "addTags")}
              onChangeStatus={() => startRowAction(c.id, "status")}
            />
          </span>
        ),
      },
    ],
    [allShownSelected, shownIds, bulk, startRowAction],
  );

  // Filter the toggleable columns by the chooser; the always-on select + actions columns stay.
  const columns = useMemo(
    () =>
      allColumns.filter(
        (c) => c.key === "select" || c.key === "actions" || visibleColumns.includes(c.key),
      ),
    [allColumns, visibleColumns],
  );

  return (
    <div className={styles.page} data-density={density}>
      <FilterPanel
        query={query}
        onChange={setQuery}
        counts={counts}
        header={
          <>
            <SaveSearchPanel currentQuery={query} onApply={setQuery} />
            <RecentSearches recents={recent.recents} onApply={setQuery} onClear={recent.clear} />
          </>
        }
      />

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
                  : `${hits.length.toLocaleString()}${hasMore ? "+" : ""} contacts`}
              </span>
            )}
          </div>
          <div className={styles.headRight}>
            {scope === "contacts" && (
              <ProspectToolbar
                query={query}
                onChange={setQuery}
                columns={TOGGLEABLE_COLUMNS}
                visibleColumns={visibleColumns}
                onVisibleColumnsChange={setVisibleColumns}
              />
            )}
            <SegmentedControl
              items={VIEWS}
              value={view}
              onChange={(v) => setView(v as "list" | "card")}
              aria-label="View"
            />
            <SegmentedControl
              items={DENSITIES}
              value={density}
              onChange={setDensity}
              aria-label="Row density"
            />
          </div>
        </div>

        {scope === "contacts" && (
          <div className={styles.searchRow}>
            <TpInput
              type="search"
              placeholder="Search name, title, company, email, LinkedIn…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              aria-label="Search prospects"
            />
            <AiSearchBox onApply={(q: ContactQuery) => setQuery(q)} />
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
            empty={!loading && hits.length === 0}
            onRetry={reload}
            emptyState={
              <EmptyState
                icon={<Users size={28} />}
                title="No matches"
                description="No contacts match this search. Adjust your filters or import more from the Import surface."
              />
            }
          >
            {view === "card" ? (
              <CardGrid hits={hits} onOpen={setPreviewId} />
            ) : (
              <DataTable
                columns={columns}
                rows={hits}
                rowKey={(c) => c.id}
                onRowClick={(c) => setPreviewId(c.id)}
                isSelected={(c) => c.id === previewId}
              />
            )}
            {hasMore && (
              <div className={styles.loadMore}>
                <TpButton variant="secondary" size="sm" loading={loading} onClick={loadMore}>
                  Load more
                </TpButton>
              </div>
            )}
          </StateSwitch>
        )}
      </section>

      {/* Lightweight preview → hands off to the heavy RecordDetail. */}
      <QuickViewDrawer
        contact={preview}
        onClose={() => setPreviewId(null)}
        onOpenFull={
          preview
            ? () => {
                setSelectedId(preview.id);
                setPreviewId(null);
              }
            : undefined
        }
      />

      <RecordDetail
        contact={selected}
        onClose={() => setSelectedId(null)}
        onRevealed={(id) => markRevealed(id)}
      />

      {bulk.count > 0 && (
        <BulkActionBar
          selection={bulk}
          query={query}
          selectedContacts={selectedContacts}
          revealableIds={revealableIds}
          tags={tags}
          requestedAction={rowAction}
          onRequestHandled={() => setRowAction(null)}
          onRevealed={(ids) => {
            for (const id of ids) markRevealed(id);
            bulk.clear();
          }}
          onMutated={() => {
            reload();
          }}
        />
      )}
    </div>
  );
}

/** Compact card view of the results (the list⇄card toggle's card mode). */
function CardGrid({ hits, onOpen }: { hits: MaskedContact[]; onOpen: (id: string) => void }) {
  return (
    <div className={styles.cardGrid}>
      {hits.map((c) => (
        <button
          key={c.id}
          type="button"
          className={styles.prospectCard}
          onClick={() => onOpen(c.id)}
        >
          <Avatar name={displayName(c)} size={32} />
          <span className={styles.cardMeta}>
            <span className={styles.name}>{displayName(c)}</span>
            <span className={styles.title}>{c.jobTitle ?? "—"}</span>
            <span className={styles.mono}>{c.emailDomain ?? "—"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
