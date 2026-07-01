// ProspectPage.tsx — the prospect master/detail surface (04 §5, 11 §4.2, 24): the faceted sidebar (which also
// hosts the Prospect/Account scope switch + Saved/Recent searches) driving a server ContactQuery, a top search
// box + AI NL box, a results header with a sort + column-chooser toolbar, the results table (list only —
// sortable, density-aware, masked glyphs, row-select, per-row overflow menu) with keyset "Load more", a
// lightweight QuickView preview Drawer that hands off to the heavy RecordDetail, and the sticky bulk-action bar
// (the full Phase-3 bulk surface). Search/filter state lives in the URL (useProspectSearch → searchUrlState),
// so a view is shareable and restored on refresh/back. Composition only; data + masking + mutations come from
// the slice (api/bulkActionsApi).
"use client";

import type {
  AccountFacetKey,
  ContactHit,
  ContactQuery,
  FacetKey,
  MaskedAccount,
} from "@leadwolf/types";
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
import { Building2, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccountFacetCounts } from "../hooks/useAccountFacetCounts";
import { useAccountSearch } from "../hooks/useAccountSearch";
import { useBulkSelection } from "../hooks/useBulkSelection";
import { useFacetCounts } from "../hooks/useFacetCounts";
import { useProspectSearch } from "../hooks/useProspectSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { RevealStoreProvider, useRevealStore } from "../hooks/useRevealStore";
import { useTags } from "../hooks/useTags";
import styles from "../prospect.module.css";
import { type ResultScope, displayName, emailGlyphFor } from "../types";
import { AccountDetailDrawer } from "./AccountDetailDrawer";
import { AccountFilterPanel } from "./AccountFilterPanel";
import { AccountsTable } from "./AccountsTable";
import { AiSearchBox } from "./AiSearchBox";
import { BulkActionBar, type RowBulkAction } from "./BulkActionBar";
import { FilterPanel } from "./FilterPanel";
import { ProspectToolbar } from "./ProspectToolbar";
import { QuickViewDrawer } from "./QuickViewDrawer";
import { RecentSearches } from "./RecentSearches";
import { RecordDetail } from "./RecordDetail";
import { RevealCell } from "./RevealCell";
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
// The fixed-option facets that get live counts in the sidebar (POST /search/facets).
const COUNT_FIELDS: FacetKey[] = ["seniority", "outreach_status", "email_status", "source"];
// The fixed-option account facets that get live counts in the Accounts sidebar (POST /account-search/facets).
const ACCOUNT_COUNT_FIELDS: AccountFacetKey[] = [
  "industry",
  "company_stage",
  "funding_stage",
  "revenue_range",
  "employee_band",
];

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
  const search = useProspectSearch();
  const { query, setQuery, hits, loading, error, hasMore, loadMore, reload, markRevealed } = search;
  const counts = useFacetCounts(query, COUNT_FIELDS);
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

  // Company-level (accounts) scope engine — independent of the contacts query, its own URL params (aq/asort/af).
  const accountSearch = useAccountSearch();
  const accountCounts = useAccountFacetCounts(accountSearch.query, ACCOUNT_COUNT_FIELDS);
  const [accountDetail, setAccountDetail] = useState<MaskedAccount | null>(null);

  // Scope lives in the URL (?scope=accounts) so the active surface is shareable + restored on refresh/back.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scope: ResultScope = searchParams?.get("scope") === "accounts" ? "accounts" : "contacts";
  const setScope = useCallback(
    (next: ResultScope) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "accounts") params.set("scope", "accounts");
      else params.delete("scope");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const [density, setDensity] = useState("comfortable");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE);
  // A pending row-level bulk action: the single id to seed + which bulk dialog to open.
  const [rowAction, setRowAction] = useState<RowBulkAction | null>(null);

  // "View N contacts" from the account drawer: switch to the Contacts scope and pin the contacts query to that
  // account via the `company` term filter (the backend ilike-matches it against accounts.domain / accounts.name /
  // contacts.emailDomain). Prefer the account domain (the most precise key); fall back to the company name.
  const viewAccountContacts = useCallback(
    (account: MaskedAccount) => {
      const pin = account.domain ?? account.name;
      const filters: ContactQuery["filters"] = [
        ...query.filters.filter((c) => !(c.kind === "term" && c.field === "company")),
        { kind: "term", field: "company", op: "include", values: [pin] },
      ];
      setQuery({ ...query, filters });
      setAccountDetail(null);
      setScope("contacts");
    },
    [query, setQuery, setScope],
  );

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

  // Accounts free-text box: the same debounce-commit pattern, committed to the account query.
  const [accountTextInput, setAccountTextInput] = useState(accountSearch.query.text ?? "");
  useEffect(() => setAccountTextInput(accountSearch.query.text ?? ""), [accountSearch.query.text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce-commit keyed on the local input.
  useEffect(() => {
    const t = accountTextInput.trim();
    if (t === (accountSearch.query.text ?? "")) return;
    const id = setTimeout(
      () => accountSearch.setQuery({ ...accountSearch.query, text: t || undefined }),
      300,
    );
    return () => clearTimeout(id);
  }, [accountTextInput]);

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

  // The Prospect/Account scope switch now lives INSIDE the sidebar (top of the rail), passed to both panels.
  const scopeSwitch = (
    <SegmentedControl
      items={SCOPES}
      value={scope}
      onChange={(v) => setScope(v as ResultScope)}
      aria-label="Result type"
    />
  );

  return (
    <div className={styles.page} data-density={density}>
      {scope === "accounts" ? (
        <AccountFilterPanel
          query={accountSearch.query}
          onChange={accountSearch.setQuery}
          counts={accountCounts}
          scopeSwitch={scopeSwitch}
        />
      ) : (
        <FilterPanel
          query={query}
          onChange={setQuery}
          counts={counts}
          scopeSwitch={scopeSwitch}
          header={
            <>
              <SaveSearchPanel currentQuery={query} onApply={setQuery} />
              <RecentSearches recents={recent.recents} onApply={setQuery} onClear={recent.clear} />
            </>
          }
        />
      )}

      <section className={styles.results}>
        <div className={styles.resultsHead}>
          <div className={styles.headLeft}>
            {scope === "contacts" ? (
              <span className={styles.count}>
                {loading
                  ? "Loading…"
                  : `${hits.length.toLocaleString()}${hasMore ? "+" : ""} contacts`}
              </span>
            ) : (
              <span className={styles.count}>
                {accountSearch.loading
                  ? "Loading…"
                  : `${accountSearch.accounts.length.toLocaleString()}${
                      accountSearch.hasMore ? "+" : ""
                    } companies`}
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
              items={DENSITIES}
              value={density}
              onChange={setDensity}
              aria-label="Row density"
            />
          </div>
        </div>

        {scope === "contacts" ? (
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
        ) : (
          <div className={styles.searchRow}>
            <TpInput
              type="search"
              placeholder="Search company name or domain…"
              value={accountTextInput}
              onChange={(e) => setAccountTextInput(e.target.value)}
              aria-label="Search companies"
            />
          </div>
        )}

        {scope === "accounts" ? (
          <StateSwitch
            loading={accountSearch.loading}
            error={accountSearch.error}
            empty={!accountSearch.loading && accountSearch.accounts.length === 0}
            onRetry={accountSearch.reload}
            emptyState={
              <EmptyState
                icon={<Building2 size={28} />}
                title="No companies"
                description="No accounts match this search. Adjust your firmographic filters or import more from the Import surface."
              />
            }
          >
            <AccountsTable
              accounts={accountSearch.accounts}
              loading={accountSearch.loading}
              onOpen={setAccountDetail}
              density={density}
            />
            {accountSearch.hasMore && (
              <div className={styles.loadMore}>
                <TpButton
                  variant="secondary"
                  size="sm"
                  loading={accountSearch.loading}
                  onClick={accountSearch.loadMore}
                >
                  Load more
                </TpButton>
              </div>
            )}
          </StateSwitch>
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
            <DataTable
              columns={columns}
              rows={hits}
              rowKey={(c) => c.id}
              onRowClick={(c) => setPreviewId(c.id)}
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
        onRevealed={(id) => {
          markRevealed(id);
          // Keep the grid row in sync with a reveal done inside the drawer.
          revealStore.refresh(id);
        }}
      />

      {/* Read-only company preview; "View N contacts" pins the contacts query to this account + switches scope. */}
      <AccountDetailDrawer
        account={accountDetail}
        onClose={() => setAccountDetail(null)}
        onViewContacts={viewAccountContacts}
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
