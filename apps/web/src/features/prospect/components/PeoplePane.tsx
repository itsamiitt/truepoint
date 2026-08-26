// PeoplePane.tsx — the People half of the Search surface (04 §5, 11 §4.2, 24; search-consolidation 01): the
// faceted sidebar (hosting Saved/Recent searches) driving a server ContactQuery, a top search box + AI NL
// box, a results header with a sort + column-chooser toolbar, the results table (list only — sortable,
// density-aware, masked glyphs, row-select, per-row overflow menu) with keyset "Load more", a lightweight
// QuickView preview Drawer that hands off to the heavy RecordDetail, and the sticky bulk-action bar (the
// full Phase-3 bulk surface). Search/filter state lives in the URL (useProspectSearch → searchUrlState), so
// a view is shareable and restored on refresh/back. Composition only; data + masking + mutations come from
// the slice (api/bulkActionsApi).
//
// It renders the SHELL GRID itself (drawer column + results column) rather than being placed inside one, so
// the drawer wraps this pane's own filter panel. The Accounts pane does the same with its panel — one
// drawer implementation, two panes, no shared mutable state between them.
//
// HISTORY: this was ProspectPage, and it carried a `?scope=accounts` → /companies redirect from the MI-1
// cutover. The search-consolidation decision (2026-08-21) folds Accounts back in as a TAB, so the redirect
// is gone; the legacy param is now translated to `?tab=accounts` in useSearchTab instead.
"use client";

import {
  AppliedFilterChips,
  SearchDrawer,
  SearchDrawerOpener,
  type SearchShell,
  WorkspaceScopeControl,
} from "@/components/search";
import shellStyles from "@/components/search/search.module.css";
import type { ContactQuery, FacetKey, Tag } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  SegmentedControl,
  StateSwitch,
  TableSkeleton,
  Tooltip,
  TpButton,
  TpChip,
} from "@leadwolf/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import dynamic from "next/dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import { searchCount } from "../bulkActionsApi";
import { activeChips, clearAllFilters } from "../filterGroups";
import {
  type BulkSelectionStore,
  useBulkSelection,
  useBulkSelectionStore,
} from "../hooks/useBulkSelection";
import { useFacetCounts } from "../hooks/useFacetCounts";
import { useProspectSearch } from "../hooks/useProspectSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { useRevealStore } from "../hooks/useRevealStore";
import { useTags } from "../hooks/useTags";
import { prospectKeys } from "../keys";
import styles from "../prospect.module.css";
import { resultHeadline } from "../resultHeadline";
import { displayName, emailGlyphForRow, profileHref } from "../types";
import type { BulkMutationEffect, RowBulkAction } from "./BulkActionBar";

// The bulk bar is ~930 lines and renders ONLY once rows are selected (`bulk.count > 0` below), so it has no
// business in the initial chunk of the surface every prospect session lands on. `next/dynamic` defers it to
// the first selection. `ssr: false` because it is selection-driven client state that never exists during a
// server render — asking for its markup up front would be work with no output.
//
// The type import above stays static: types are erased at build time, so it costs nothing and keeps the
// props checked.
const BulkActionBar = dynamic(() => import("./BulkActionBar").then((m) => m.BulkActionBar), {
  ssr: false,
});
// The saved + recent searches block sits UNDER the filters and carries its own dialogs, menu and client — an
// intent (PA-3), deferred so the quick tier + grid fit /search's 200kB First Load budget.
const RailFooter = dynamic(() => import("./RailFooter").then((m) => m.RailFooter), {
  ssr: false,
  loading: () => null,
});
import type { ProspectRow } from "../databaseRows";
import { FilterRail } from "./FilterRail";
import { ProspectToolbar } from "./ProspectToolbar";
import { QuickStartPresets } from "./QuickStartPresets";
import { QuickViewDrawer } from "./QuickViewDrawer";
import { RecordDetail } from "./RecordDetail";
import { RevealCell } from "./RevealCell";
import { RowActions } from "./RowActions";
import { SearchBox } from "./SearchBox";
import { RowSelectCheckbox, SelectAllCheckbox } from "./SelectionControls";
import { WorkspaceOnlyNotice } from "./WorkspaceOnlyNotice";

const DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
// The fixed-option facets that get live counts in the sidebar (POST /search/facets).
const COUNT_FIELDS: FacetKey[] = ["seniority", "outreach_status", "email_status", "source"];

// The toggleable result columns (the "select" checkbox + "actions" menu are always shown, not toggleable).
const TOGGLEABLE_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email status" },
  { key: "address", label: "Email" },
  { key: "phone", label: "Phone" },
];
const DEFAULT_VISIBLE = TOGGLEABLE_COLUMNS.map((c) => c.key);

function PeoplePaneInner({ shell }: { shell: SearchShell }) {
  // Only ONE pane is mounted at a time (the composer picks by tab), so this pane's engines are never
  // running for a grid nobody is looking at. That replaces the old both-scopes-mounted arrangement, where
  // React's no-conditional-hooks rule forced an `enabled` flag through every hook to stop the inactive
  // scope firing four wasted round-trips on every visit to the app's busiest surface.
  const search = useProspectSearch({
    includeDatabase: shell.workspace.includeDatabase,
    excludeOwned: !shell.workspace.includeOwned,
  });
  const {
    query,
    setQuery,
    hits,
    databaseCount,
    loading,
    error,
    hasMore,
    loadMore,
    reload,
    markRevealed,
    patchRows,
    removeRows,
    materializeRow,
  } = search;
  const queryClient = useQueryClient();
  const counts = useFacetCounts(query, COUNT_FIELDS);
  // The REAL total for the header (POST /search/count) — previously the header printed the loaded page
  // size ("50+") as if it were the dataset, which read as missing contacts on any workspace >1 page.
  const countResult = useQuery({
    queryKey: prospectKeys.contactCount(query),
    queryFn: () => searchCount(query),
    staleTime: 30_000,
  }).data;
  const totalCount = countResult?.total;
  // The server stops counting at its cap (P2.3) — render the floor as "10,000+", never as an exact number.
  const totalCapped = countResult?.capped ?? false;
  const recent = useRecentSearches();
  const { tags } = useTags();

  // Bulk-hydrate the already-owned reveal data for the visible rows so the grid shows real email/phone inline
  // (idempotent per id). Owned rows are those the search projection marked with a non-empty revealedTypes.
  const revealStore = useRevealStore();
  const { hydrate: hydrateRevealed } = revealStore;
  useEffect(() => {
    const ownedIds = hits.filter((h) => (h.revealedTypes?.length ?? 0) > 0).map((h) => h.id);
    if (ownedIds.length > 0) hydrateRevealed(ownedIds);
  }, [hits, hydrateRevealed]);

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
  // Two different empties need two different words (design interaction rules): nothing asked yet vs. a
  // filter that excluded everything.
  const isPristine = !query.text && query.filters.length === 0;

  // Multi-row selection for the bulk-action bar (distinct from the single-row Drawer selection). The page
  // holds only the STORE (identity-stable, costs no renders); the checkboxes and the bar host subscribe
  // themselves, so a toggle re-renders 1-2 checkboxes instead of the whole page (perf-audit P3.1).
  const selectionStore = useBulkSelectionStore();
  // Only OWNED rows are selectable: bulk actions address contacts by id, and a database row has none.
  const shownIds = useMemo(() => hits.filter((c) => !c.databaseSlug).map((c) => c.id), [hits]);

  // Seed the bulk selection to a single row, then ask the bar to open the matching dialog.
  const startRowAction = useCallback(
    (id: string, action: RowBulkAction) => {
      selectionStore.clear();
      selectionStore.setMany([id], true);
      setRowAction(action);
    },
    [selectionStore],
  );

  const allColumns: Column<ProspectRow>[] = useMemo(
    () => [
      {
        key: "select",
        header: (
          <SelectAllCheckbox
            store={selectionStore}
            shownIds={shownIds}
            className={styles.headCheck}
          />
        ),
        width: 36,
        cell: (c) => (
          <RowSelectCheckbox
            store={selectionStore}
            id={c.id}
            label={`Select ${displayName(c)}`}
            disabledReason={c.databaseSlug ? "Reveal to save this person first" : undefined}
            className={styles.rowCheck}
          />
        ),
      },
      {
        key: "name",
        header: "Name",
        sortValue: (c) => displayName(c),
        cell: (c) => {
          const href = profileHref(c);
          return (
            <span className={styles.nameCell}>
              <span className={styles.nameMeta}>
                <span className={styles.name}>
                  {displayName(c)}
                  {c.databaseSlug ? (
                    // Not colour alone: the chip carries the word (WCAG 2.2 AA), and it is the one place
                    // the grid says which side a row is on — its reveal is what saves it.
                    <>
                      {" "}
                      <TpChip>Not saved</TpChip>
                    </>
                  ) : null}
                </span>
                <span className={styles.title}>
                  {c.jobTitle ?? "—"}
                  {href ? (
                    <>
                      {" · "}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Open profile"
                      >
                        profile
                      </a>
                    </>
                  ) : null}
                </span>
              </span>
            </span>
          );
        },
      },
      {
        key: "company",
        header: "Company",
        // Account name first (works for email-less contacts — capture/import rows), email domain as the
        // fallback facet the column used to show exclusively.
        sortValue: (c) => c.companyName ?? c.emailDomain ?? "",
        cell: (c) =>
          c.companyName ? (
            <span>{c.companyName}</span>
          ) : (
            <span className={styles.mono}>{c.emailDomain ?? "—"}</span>
          ),
      },
      {
        key: "email",
        header: "Email status",
        align: "center",
        width: 56,
        sortValue: (c) => c.emailStatus,
        cell: (c) => {
          const g = emailGlyphForRow(c);
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
        header: "Email",
        cell: (c) => (
          <RevealCell
            contact={c}
            field="email"
            onRevealed={markRevealed}
            onMaterialized={materializeRow}
          />
        ),
      },
      {
        key: "phone",
        header: "Phone",
        sortValue: (c) => (c.hasPhone ? 1 : 0),
        cell: (c) => (
          <RevealCell
            contact={c}
            field="phone"
            onRevealed={markRevealed}
            onMaterialized={materializeRow}
          />
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
            {c.databaseSlug ? (
              // A not-saved row has no list/tag/status — those are workspace facts; its save gesture is
              // the reveal. The menu keeps the honest email hint and the LinkedIn link.
              <RowActions
                contact={c}
                onOpenLinkedin={
                  c.databaseUrl
                    ? () => window.open(c.databaseUrl, "_blank", "noopener,noreferrer")
                    : undefined
                }
              />
            ) : (
              <RowActions
                contact={c}
                onAddToList={() => startRowAction(c.id, "list")}
                onTag={() => startRowAction(c.id, "addTags")}
                onChangeStatus={() => startRowAction(c.id, "status")}
              />
            )}
          </span>
        ),
      },
    ],
    // The store is identity-stable, so selection changes no longer rebuild the columns (and with them every
    // cell of every row) — only new rows (shownIds) or new handlers do.
    [selectionStore, shownIds, startRowAction, markRevealed, materializeRow],
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
    <div className={shellStyles.page} data-collapsed={shell.collapsed} data-density={density}>
      <SearchDrawer
        collapsed={shell.collapsed}
        isOverlay={shell.isOverlay}
        onToggle={shell.toggle}
        onClose={shell.close}
        tabs={shell.tabs}
      >
        <FilterRail
          query={query}
          onChange={setQuery}
          counts={counts}
          scope={shell.workspace.scope}
          footer={
            <RailFooter
              query={query}
              onApply={setQuery}
              recents={recent.recents}
              onClearRecents={recent.clear}
            />
          }
        />
      </SearchDrawer>

      <section className={styles.results}>
        <div className={styles.resultsHead}>
          <div className={styles.headLeft}>
            {/* Visible only while the rail is off-canvas (≤768px, collapsed) — otherwise the toggle in the
                rail itself is the way back, and two openers would be one too many. */}
            <SearchDrawerOpener onOpen={shell.toggle} />
            {/* The People/Accounts switch lives in the rail; while the rail is collapsed it is mirrored
                here so the tab is never out of reach (decisions.md 2026-08-25). */}
            {shell.collapsed ? <span className={styles.headTabs}>{shell.tabs}</span> : null}
            <span className={styles.count}>
              {resultHeadline({
                scope: shell.workspace.scope,
                loading,
                saved: totalCount ?? hits.length - databaseCount,
                savedIsFloor: totalCapped || (totalCount === undefined && hasMore),
                available: databaseCount,
              })}
            </span>
          </div>
          <div className={styles.headRight}>
            <ProspectToolbar
              query={query}
              onChange={setQuery}
              columns={TOGGLEABLE_COLUMNS}
              visibleColumns={visibleColumns}
              onVisibleColumnsChange={setVisibleColumns}
            />
            <SegmentedControl
              items={DENSITIES}
              value={density}
              onChange={setDensity}
              aria-label="Row density"
            />
          </div>
        </div>

        <div className={styles.searchRow}>
          <SearchBox value={textInput} onChange={setTextInput} onApplyQuery={setQuery} />
          <WorkspaceScopeControl
            scope={shell.workspace.scope}
            onChange={shell.workspace.setScope}
          />
        </div>

        {/* Renders nothing when no filter is active — never a "no filters applied" line. */}
        <AppliedFilterChips
          chips={activeChips(query)}
          query={query}
          onChange={setQuery}
          onClearAll={() => setQuery(clearAllFilters(query))}
        />
        {/* A saved-only filter narrows the list to saved contacts — say so, instead of letting the
            database half vanish silently. Moot when the scope already excludes the database half. */}
        {shell.workspace.includeDatabase ? (
          <WorkspaceOnlyNotice query={query} onChange={setQuery} />
        ) : null}

        {
          <StateSwitch
            loading={loading}
            error={error}
            empty={!loading && hits.length === 0}
            onRetry={reload}
            skeleton={<TableSkeleton rows={10} />}
            emptyState={
              isPristine ? (
                <div className={styles.emptyWrap}>
                  <EmptyState
                    icon={<Users size={28} />}
                    title="Search the TruePoint database"
                    description="Filter by title, location or company — or start from one of these."
                  />
                  <QuickStartPresets onApply={setQuery} />
                </div>
              ) : (
                <EmptyState
                  icon={<Users size={28} />}
                  title="No matches"
                  description="No people match these filters."
                  action={
                    <TpButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setQuery(clearAllFilters({ ...query, text: undefined }))}
                    >
                      Clear all filters
                    </TpButton>
                  }
                />
              )
            }
          >
            <DataTable
              columns={columns}
              rows={hits}
              rowKey={(c) => c.id}
              // A database row opens its full masked Layer-0 profile in a drawer (stage 3); its reveal — in
              // the grid or in that drawer — is what saves it (decisions.md 2026-08-25). An owned row still
              // opens the lightweight QuickView, which hands off to RecordDetail.
              onRowClick={(c) =>
                c.databaseSlug ? shell.openProfile("person", c.databaseSlug) : setPreviewId(c.id)
              }
              isSelected={(c) => c.id === previewId}
            />
            {hasMore && (
              <div className={styles.loadMore}>
                <TpButton variant="secondary" size="sm" loading={loading} onClick={loadMore}>
                  Load more
                </TpButton>
              </div>
            )}
          </StateSwitch>
        }
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
        onRevealed={(id) => {
          markRevealed(id);
          // Keep the grid row in sync with a reveal done inside the drawer.
          revealStore.refresh(id);
        }}
      />

      <ProspectBulkBar
        store={selectionStore}
        hits={hits}
        query={query}
        tags={tags}
        requestedAction={rowAction}
        onRequestHandled={() => setRowAction(null)}
        onRevealed={(ids) => {
          for (const id of ids) {
            markRevealed(id);
            // Hydrate each newly-revealed row so the grid shows its value inline (Phase 3 will batch this).
            revealStore.refresh(id);
          }
          selectionStore.clear();
        }}
        onMutated={(effect) => {
          // P3.3b: a bulk mutation used to refetch EVERY loaded page. When the bar says exactly what
          // changed (explicit-id selections), patch the cached rows / invalidate the narrow keys instead.
          // Reload stays the fallback for select-all-matching and for anything that changes which rows
          // match the ACTIVE query (a term filter on the mutated field).
          if (!effect) {
            reload();
            return;
          }
          const filtersOn = (field: string) =>
            query.filters.some((f) => f.kind === "term" && f.field === field);
          switch (effect.kind) {
            case "status":
              if (filtersOn("outreach_status")) reload();
              else patchRows(effect.ids, (r) => ({ ...r, outreachStatus: effect.outreachStatus }));
              break;
            case "owner":
              if (filtersOn("owner")) reload();
              else patchRows(effect.ids, (r) => ({ ...r, ownerUserId: effect.ownerUserId }));
              break;
            case "archived":
              // Rows leave the result set; the header total + facet rail shift with them — two cheap
              // requests instead of refetching every page of rows.
              removeRows(effect.ids);
              void queryClient.invalidateQueries({
                queryKey: prospectKeys.contactCount(query),
              });
              void queryClient.invalidateQueries({
                queryKey: prospectKeys.contactFacets(query, COUNT_FIELDS),
              });
              break;
            case "tags":
              // Grid rows don't render tags — only the per-tag id lists behind filter-by-tag and the
              // rail's usage counts are stale.
              for (const tagId of effect.tagIds)
                void queryClient.invalidateQueries({
                  queryKey: prospectKeys.taggedRecords(tagId),
                });
              void queryClient.invalidateQueries({ queryKey: prospectKeys.tags() });
              break;
            case "list":
              // Nothing on this grid changed; the lists feature's caches are what went stale.
              void queryClient.invalidateQueries({ queryKey: ["lists"] });
              break;
            case "queued":
              break; // values land when the job completes — nothing to refetch yet
          }
        }}
      />
    </div>
  );
}

/**
 * The bulk bar's SUBSCRIBING host (perf-audit P3.1): the one component that re-renders per selection change.
 * It derives the selection view + the selected/revealable rows here so the page above never subscribes —
 * mounting/unmounting the (dynamically-imported) bar as the count crosses zero, exactly as before.
 */
function ProspectBulkBar({
  store,
  hits,
  query,
  tags,
  requestedAction,
  onRequestHandled,
  onRevealed,
  onMutated,
}: {
  store: BulkSelectionStore;
  hits: ProspectRow[];
  query: ContactQuery;
  tags: Tag[];
  requestedAction: RowBulkAction | null;
  onRequestHandled: () => void;
  onRevealed: (ids: string[]) => void;
  onMutated: (effect?: BulkMutationEffect) => void;
}) {
  const sel = useBulkSelection(store);
  const selectedContacts = useMemo(
    () => hits.filter((c) => sel.selectedIds.has(c.id)),
    [hits, sel.selectedIds],
  );
  const revealableIds = useMemo(
    () => selectedContacts.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id),
    [selectedContacts],
  );
  if (sel.count === 0) return null;
  return (
    <BulkActionBar
      selection={sel}
      query={query}
      selectedContacts={selectedContacts}
      revealableIds={revealableIds}
      tags={tags}
      requestedAction={requestedAction}
      onRequestHandled={onRequestHandled}
      onRevealed={onRevealed}
      onMutated={onMutated}
    />
  );
}

/** Public entry. The RevealStore is provided by the Search composer — above both panes AND the profile
 *  drawers — so a reveal made in a drawer and one made in the grid derive their state from one source. */
export function PeoplePane({ shell }: { shell: SearchShell }) {
  return <PeoplePaneInner shell={shell} />;
}
