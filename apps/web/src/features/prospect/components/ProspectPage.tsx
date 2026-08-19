// ProspectPage.tsx — the prospect master/detail surface (04 §5, 11 §4.2, 24): the faceted sidebar (hosting
// Saved/Recent searches; the old Accounts scope moved to /companies — the MI-1 cutover, redirects below)
// driving a server ContactQuery, a top search
// box + AI NL box, a results header with a sort + column-chooser toolbar, the results table (list only —
// sortable, density-aware, masked glyphs, row-select, per-row overflow menu) with keyset "Load more", a
// lightweight QuickView preview Drawer that hands off to the heavy RecordDetail, and the sticky bulk-action bar
// (the full Phase-3 bulk surface). Search/filter state lives in the URL (useProspectSearch → searchUrlState),
// so a view is shareable and restored on refresh/back. Composition only; data + masking + mutations come from
// the slice (api/bulkActionsApi).
"use client";

import type { ContactQuery, FacetKey } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  SegmentedControl,
  StateSwitch,
  Tooltip,
  TpButton,
  TpCheckbox,
  TpInput,
} from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { searchCount } from "../bulkActionsApi";
import { useBulkSelection } from "../hooks/useBulkSelection";
import { useFacetCounts } from "../hooks/useFacetCounts";
import { useProspectSearch } from "../hooks/useProspectSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { RevealStoreProvider, useRevealStore } from "../hooks/useRevealStore";
import { useTags } from "../hooks/useTags";
import { prospectKeys } from "../keys";
import styles from "../prospect.module.css";
import { displayName, emailGlyphFor, profileHref } from "../types";
import { AiSearchBox } from "./AiSearchBox";
import type { RowBulkAction } from "./BulkActionBar";

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
import type { ProspectRow } from "../databaseRows";
import { AddToWorkspaceButton } from "./AddToWorkspaceButton";
import { FilterPanel } from "./FilterPanel";
import { ProspectToolbar } from "./ProspectToolbar";
import { QuickViewDrawer } from "./QuickViewDrawer";
import { RecentSearches } from "./RecentSearches";
import { RecordDetail } from "./RecordDetail";
import { RevealCell } from "./RevealCell";
import { RowActions } from "./RowActions";
import { SaveSearchPanel } from "./SaveSearchPanel";

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
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "phone", label: "Phone" },
];
const DEFAULT_VISIBLE = TOGGLEABLE_COLUMNS.map((c) => c.key);

function ProspectPageInner() {
  // Scope is resolved FIRST, because it gates the two search engines below. React forbids conditional hooks, so
  // both engines are always mounted — but only the active one may issue requests. Previously scope was read
  // *after* all four hooks, so every visit to this page fired the inactive scope's search AND facet-count POSTs
  // for a grid that was never rendered: four wasted round-trips on the app's busiest surface.
  const router = useRouter();
  const searchParams = useSearchParams();
  // CUTOVER (market-intelligence MI-1, D-9 regroup): the Accounts scope moved to the /companies
  // destination. Old ?scope=accounts deep-links redirect there WITH their query string — the aq/asort/af
  // account codec is shared, so a shared account view keeps working at its new home.
  const legacyAccountsScope = searchParams?.get("scope") === "accounts";
  useEffect(() => {
    if (!legacyAccountsScope) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("scope");
    const qs = params.toString();
    router.replace(qs ? `/companies?${qs}` : "/companies");
  }, [legacyAccountsScope, router, searchParams]);
  const contactsActive = !legacyAccountsScope;

  const search = useProspectSearch({ enabled: contactsActive });
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
  } = search;
  const counts = useFacetCounts(query, COUNT_FIELDS, { enabled: contactsActive });
  // The REAL total for the header (POST /search/count) — previously the header printed the loaded page
  // size ("50+") as if it were the dataset, which read as missing contacts on any workspace >1 page.
  const countResult = useQuery({
    queryKey: prospectKeys.contactCount(query),
    queryFn: () => searchCount(query),
    enabled: contactsActive,
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

  // Multi-row selection for the bulk-action bar (distinct from the single-row Drawer selection).
  const bulk = useBulkSelection();
  // Only OWNED rows are selectable: bulk actions address contacts by id, and a database row has none.
  const shownIds = useMemo(() => hits.filter((c) => !c.databaseSlug).map((c) => c.id), [hits]);
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

  const allColumns: Column<ProspectRow>[] = useMemo(
    () => [
      {
        key: "select",
        header: (
          <TpCheckbox
            className={styles.headCheck}
            aria-label="Select all shown"
            checked={allShownSelected}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => bulk.setMany(shownIds, e.target.checked)}
          />
        ),
        width: 36,
        cell: (c) => (
          <TpCheckbox
            className={styles.rowCheck}
            checked={bulk.isSelected(c.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => bulk.toggle(c.id)}
            aria-label={`Select ${displayName(c)}`}
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
                <span className={styles.name}>{displayName(c)}</span>
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
        header: "Email",
        cell: (c) => <RevealCell contact={c} field="email" onRevealed={markRevealed} />,
      },
      {
        key: "phone",
        header: "Phone",
        sortValue: (c) => (c.hasPhone ? 1 : 0),
        cell: (c) => <RevealCell contact={c} field="phone" onRevealed={markRevealed} />,
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
              <AddToWorkspaceButton slug={c.databaseSlug} name={displayName(c)} />
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
    [allShownSelected, shownIds, bulk, startRowAction, markRevealed],
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
            <span className={styles.count}>
              {loading
                ? "Loading…"
                : `${(totalCount ?? hits.length - databaseCount).toLocaleString()}${
                    totalCapped || (totalCount === undefined && hasMore) ? "+" : ""
                  } in your workspace${
                    databaseCount > 0
                      ? ` · ${databaseCount.toLocaleString()} more in the database`
                      : ""
                  }`}
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
          <TpInput
            type="search"
            placeholder="Search name, title, company, email, LinkedIn…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            aria-label="Search prospects"
          />
          <AiSearchBox onApply={(q: ContactQuery) => setQuery(q)} />
        </div>

        {
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
            <DataTable
              columns={columns}
              rows={hits}
              rowKey={(c) => c.id}
              // A database row has no workspace record to open — add it first, then it behaves like any contact.
              onRowClick={(c) => (c.databaseSlug ? undefined : setPreviewId(c.id))}
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
            for (const id of ids) {
              markRevealed(id);
              // Hydrate each newly-revealed row so the grid shows its value inline (Phase 3 will batch this).
              revealStore.refresh(id);
            }
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

/** Public entry: wraps the surface in the RevealStore so the grid + detail derive reveal state from one source. */
export function ProspectPage() {
  return (
    <RevealStoreProvider>
      <ProspectPageInner />
    </RevealStoreProvider>
  );
}
