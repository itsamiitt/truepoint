// PeoplePane.tsx — the People half of the Search surface (04 §5, 11 §4.2, 24; search-consolidation 01): the
// filter rail (hosting Saved/Recent searches under the filters) driving a server ContactQuery, ONE toolbar
// line — search box with a "Describe" mode, the All/Saved/Not-saved scope switch, the column chooser — the
// results table (list only — compact, masked glyphs, row-select, per-row overflow menu) paged 25 rows at a
// time behind a Previous/Next pager over the keyset pages (2026-08-31 pagination; sort control and density
// switch removed — compact is the default and relevance the sort), a lightweight QuickView preview Drawer
// that hands off to the heavy RecordDetail, and the sticky bulk-action bar (the full Phase-3 bulk surface).
// Search/filter state lives in the URL (useProspectSearch → searchUrlState), so a view is shareable and
// restored on refresh/back. Composition only; data + masking + mutations come from the slice
// (api/bulkActionsApi).
//
// It renders the SHELL GRID itself (drawer column + results column) rather than being placed inside one, so
// the drawer wraps this pane's own filter rail. The Accounts pane does the same with its panel — one
// drawer implementation, two panes, no shared mutable state between them.
//
// Two row states, one verb (decisions.md 2026-08-25): SAVED (in this workspace) and NOT SAVED (in the
// TruePoint database). A not-saved row carries a "Not saved" chip, opens its full masked profile on click,
// and its REVEAL is what saves it — there is no "Add to workspace" anywhere on this surface.
//
// HISTORY: this was ProspectPage, and it carried a `?scope=accounts` → /companies redirect from the MI-1
// cutover. The search-consolidation decision (2026-08-21) folds Accounts back in as a TAB, so the redirect
// is gone; the legacy param is now translated to `?tab=accounts` in useSearchTab instead.
"use client";

import {
  AppliedFilterChips,
  ColumnChooser,
  ScopeNotice,
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
  Pagination,
  StateSwitch,
  TableSkeleton,
  TpButton,
} from "@leadwolf/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import dynamic from "next/dynamic";

import { useSessionIdentity } from "@/lib/useSessionIdentity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { searchCount } from "../bulkActionsApi";
import { activeChips, clearAllFilters, facetLabel } from "../filterGroups";
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
import { QuickStartPresets } from "./QuickStartPresets";
import { QuickViewDrawer } from "./QuickViewDrawer";
import { RecordDetail } from "./RecordDetail";
import { SearchBox } from "./SearchBox";
import { DEFAULT_VISIBLE_COLUMNS, TOGGLEABLE_COLUMNS, buildPeopleColumns } from "./peopleColumns";

// EVERY fixed-option facet gets live counts in the sidebar (POST /search/facets) — a counted list next to
// a bare one read as broken. owner + phone_line_type are facet-count-supported (searchRepository FACET map).
const COUNT_FIELDS: FacetKey[] = [
  "seniority",
  "outreach_status",
  "email_status",
  "source",
  "phone_line_type",
  "owner",
];
// One UI page of the grid (2026-08-31 pagination) — matches the engine's keyset PAGE_SIZE, so paging past
// the loaded rows costs exactly one fetch.
const GRID_PAGE_SIZE = 25;

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
    databaseHasMore,
    databaseDroppedFields,
    workspaceDroppedFields,
    loading,
    loadingMore,
    error,
    hasMore,
    workspaceHasMore,
    loadMore,
    reload,
    markRevealed,
    patchRows,
    removeRows,
    materializeRow,
  } = search;
  const queryClient = useQueryClient();
  // Facet counts are computed by the WORKSPACE engine. In "Not saved" the list is the database population,
  // so those numbers would be flatly wrong — skip the request and the sidebar omits counts (honest blank
  // beats a wrong number). In "All" they still describe only the saved half; the rail says so.
  const workspaceCountsApply = shell.workspace.scope !== "exclude";
  const counts = useFacetCounts(query, COUNT_FIELDS, { enabled: workspaceCountsApply });
  // The REAL total for the header (POST /search/count) — previously the header printed the loaded page
  // size ("50+") as if it were the dataset, which read as missing contacts on any workspace >1 page.
  // Gated on the same skip as the workspace search itself. Without this the header prints a real workspace
  // total beside zero workspace rows, and the request carries a satellite field the workspace count endpoint
  // has no clause for.
  const workspaceSkipped = workspaceDroppedFields.length > 0;
  const countResult = useQuery({
    queryKey: prospectKeys.contactCount(query),
    queryFn: () => searchCount(query),
    enabled: !workspaceSkipped,
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE_COLUMNS);
  // A pending row-level bulk action: the single id to seed + which bulk dialog to open.
  const [rowAction, setRowAction] = useState<RowBulkAction | null>(null);

  // Which 25-row page of the merged list is showing (2026-08-31 pagination). Client state over the loaded
  // keyset pages. Reset on any query or scope change — page 3 of one search is not page 3 of another.
  // Keyed on the query's CONTENT, not the object: the query is re-derived from searchParams, so keying on
  // identity reset the page whenever any unrelated URL param changed — opening a profile drawer (?person=)
  // threw the user from page 4 back to page 1.
  const [page, setPage] = useState(0);
  const querySignature = useMemo(
    () => JSON.stringify([query.text ?? "", query.sort, query.filters]),
    [query],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the search identity, not read values.
  useEffect(() => setPage(0), [querySignature, shell.workspace.scope]);

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

  // The visible 25-row slice, and the pager facts derived from it. A page past the loaded rows (Next just
  // triggered the fetch) renders the skeleton until the keyset page lands; a page emptied by removals
  // (archive) clamps back to the last page that still has rows.
  const pageRows = useMemo(
    () => hits.slice(page * GRID_PAGE_SIZE, (page + 1) * GRID_PAGE_SIZE),
    [hits, page],
  );
  const lastLoadedPage = Math.max(0, Math.ceil(hits.length / GRID_PAGE_SIZE) - 1);
  useEffect(() => {
    if (page > lastLoadedPage && !loadingMore && !loading) setPage(lastLoadedPage);
  }, [page, lastLoadedPage, loadingMore, loading]);
  const hasNextPage = hits.length > (page + 1) * GRID_PAGE_SIZE || hasMore;
  const goNext = useCallback(() => setPage((p) => p + 1), []);
  // Keep the CURRENT page filled: when the visible slice is short of 25 and more rows exist (the workspace
  // half ended mid-page, or Next just outran the loaded rows), fetch until the page is full or the data is
  // exhausted. This replaces the fetch-on-Next call — one place decides when a fetch is owed.
  useEffect(() => {
    if (hasMore && !loadingMore && !loading && hits.length < (page + 1) * GRID_PAGE_SIZE)
      loadMore();
  }, [hasMore, loadingMore, loading, hits.length, page, loadMore]);
  // "Showing X–Y", with a total ONLY when it is exact (everything loaded, no floors) — a floor here and a
  // differently-shaped floor in the headline read as two disagreeing numbers for the same list.
  const pagerLabel =
    hits.length === 0
      ? undefined
      : `Showing ${page * GRID_PAGE_SIZE + 1}–${Math.min(hits.length, (page + 1) * GRID_PAGE_SIZE)}${
          hasMore || databaseHasMore ? "" : ` of ${hits.length.toLocaleString()}`
        }`;

  // Only SAVED rows are selectable: bulk actions address contacts by id, and a not-saved row has none.
  // Scoped to the visible page so select-all means "select what I can see".
  const shownIds = useMemo(
    () => pageRows.filter((c) => !c.databaseSlug).map((c) => c.id),
    [pageRows],
  );

  // The Owner facet's options. A "Me" entry from the session identity is what makes "My prospects" askable;
  // the full teammate list needs a members source this slice may not import (lint:cross-feature) and stays a
  // documented follow-up. Any owner id the URL carries beyond these is labelled as a teammate, never shown
  // as a raw UUID.
  const { userId } = useSessionIdentity();
  const owners = useMemo(() => (userId ? [{ value: userId, label: "Me" }] : []), [userId]);
  const ownerLabel = useCallback(
    (value: string) =>
      owners.find((o) => o.value === value)?.label ?? `Teammate ${value.slice(0, 8)}`,
    [owners],
  );

  const appliedChips = useMemo(
    () =>
      activeChips(query).map((chip) =>
        // The generic labeller falls back to the raw value for facets without a fixed option list — for
        // Owner that was a UUID in the chip. Rewrite just the value part of the label.
        chip.field === "owner"
          ? {
              ...chip,
              label: chip.label.replace(/: (.+)$/, (_, v: string) => `: ${ownerLabel(v)}`),
            }
          : chip,
      ),
    [query, ownerLabel],
  );

  // The rail's stat card (user call 2026-08-31 — replaced the results-area headline): MATCHING = everyone
  // the applied filters reach across both engines (saved + database), SAVED = the workspace's own share.
  // Floors keep their "+": the database side is only ever counted as far as it has been paged.
  const savedCount = workspaceSkipped
    ? hits.length - databaseCount
    : (totalCount ?? hits.length - databaseCount);
  // The saved floor listens to the WORKSPACE half only — the merged hasMore includes the database cursor,
  // which must not pin a "+" on a fully-counted saved number.
  const savedFloor = totalCapped || (totalCount === undefined && workspaceHasMore);
  const totalFloor = savedFloor || databaseHasMore;
  const railStats = loading
    ? { total: "…", saved: "…" }
    : {
        total: `${(savedCount + databaseCount).toLocaleString()}${totalFloor ? "+" : ""}`,
        saved: `${savedCount.toLocaleString()}${savedFloor ? "+" : ""}`,
      };

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
    () =>
      buildPeopleColumns({
        selectionStore,
        shownIds,
        onRevealed: markRevealed,
        onMaterialized: materializeRow,
        onRowAction: startRowAction,
      }),
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
    <div className={shellStyles.page} data-collapsed={shell.collapsed} data-density="compact">
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
          counts={workspaceCountsApply ? counts : undefined}
          owners={owners}
          scope={shell.workspace.scope}
          stats={railStats}
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
        {/* ONE toolbar line (2026-08-31): search box (with the Describe AI mode), the All/Saved/Not-saved
            scope switch, and the column chooser — the whole row's width is working controls. */}
        <div className={styles.searchRow}>
          {/* Visible only while the rail is off-canvas (≤768px, collapsed) — otherwise the toggle in the
              rail itself is the way back, and two openers would be one too many. */}
          <SearchDrawerOpener onOpen={shell.toggle} />
          {/* The People/Accounts switch lives in the rail; while the rail is collapsed it is mirrored
              here so the tab is never out of reach (decisions.md 2026-08-25). */}
          {shell.collapsed ? <span className={styles.headTabs}>{shell.tabs}</span> : null}
          <SearchBox value={textInput} onChange={setTextInput} onApplyQuery={setQuery} />
          <WorkspaceScopeControl
            scope={shell.workspace.scope}
            onChange={shell.workspace.setScope}
          />
          <ColumnChooser
            columns={TOGGLEABLE_COLUMNS}
            visibleColumns={visibleColumns}
            onVisibleColumnsChange={setVisibleColumns}
            withLabel
          />
        </div>

        {/* The result numbers moved into the rail's stat card (user call 2026-08-31) — this row carries
            only the applied chips, and only when at least one filter is active. */}
        {appliedChips.length > 0 ? (
          <div className={styles.metaRow}>
            <AppliedFilterChips
              chips={appliedChips}
              query={query}
              onChange={setQuery}
              onClearAll={() => setQuery(clearAllFilters(query))}
              inline
            />
          </div>
        ) : null}

        {/* Only when workspace-only filters are actually suppressing the database half — say so, instead of
            letting the not-saved half vanish silently. Moot when the scope already excludes it. */}
        <ScopeNotice
          fields={shell.workspace.includeDatabase ? databaseDroppedFields : []}
          labelFor={facetLabel}
        />
        {/* The mirror: a Layer-0 satellite filter the workspace overlay cannot answer at all. */}
        <ScopeNotice fields={workspaceDroppedFields} labelFor={facetLabel} skipped="workspace" />

        {
          <StateSwitch
            loading={loading}
            error={error}
            empty={!loading && hits.length === 0}
            onRetry={reload}
            skeleton={<TableSkeleton rows={25} />}
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
                  description={
                    workspaceSkipped
                      ? "Nobody in the TruePoint database matches this search. Try broadening the background filters."
                      : "No people match these filters."
                  }
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
            {loadingMore && pageRows.length === 0 ? (
              // Next was clicked past the loaded rows — the keyset page is in flight. Full page height so
              // the pager underneath does not jump when the rows land.
              <TableSkeleton rows={25} />
            ) : (
              <DataTable
                columns={columns}
                rows={pageRows}
                rowKey={(c) => c.id}
                // A not-saved row opens its full masked Layer-0 profile in a drawer (stage 3); its reveal —
                // in the grid or in that drawer — is what saves it (decisions.md 2026-08-25). A saved row
                // still opens the lightweight QuickView, which hands off to RecordDetail.
                onRowClick={(c) =>
                  c.databaseSlug ? shell.openProfile("person", c.databaseSlug) : setPreviewId(c.id)
                }
                isSelected={(c) => c.id === previewId}
              />
            )}
            {page > 0 || hasNextPage ? (
              // Search v4: the range reads on the left, the pager buttons on the right.
              <div className={styles.pagerRow}>
                <span className={styles.pagerRange}>{pagerLabel}</span>
                <Pagination
                  hasPrev={page > 0}
                  hasNext={hasNextPage && !loadingMore}
                  onPrev={() => setPage((p) => Math.max(0, p - 1))}
                  onNext={goNext}
                />
              </div>
            ) : null}
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
