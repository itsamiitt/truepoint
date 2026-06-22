// ProspectPage.tsx — the prospect master/detail surface (04 §5, 11 §4.2, 24): a faceted FilterPanel rail
// driving a server ContactQuery, a top search box + AI NL box, the results table (sortable, density-aware,
// masked glyphs, row-select) with a list⇄card toggle and keyset "Load more", the record-detail Drawer, and
// the sticky bulk-action bar. Search/filter state lives in the URL (useProspectSearch → searchUrlState), so a
// view is shareable and restored on refresh/back. Composition + view state; data + masking come from the slice.
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
import { useEffect, useMemo, useState } from "react";
import { useBulkSelection } from "../hooks/useBulkSelection";
import { useFacetCounts } from "../hooks/useFacetCounts";
import { useProspectSearch } from "../hooks/useProspectSearch";
import styles from "../prospect.module.css";
import { type ResultScope, displayName, emailGlyphFor, maskedEmail } from "../types";
import { AiSearchBox } from "./AiSearchBox";
import { BulkActionBar } from "./BulkActionBar";
import { FilterPanel } from "./FilterPanel";
import { RecordDetail } from "./RecordDetail";

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

  const [scope, setScope] = useState<ResultScope>("contacts");
  const [density, setDensity] = useState("comfortable");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const selected = useMemo(() => hits.find((c) => c.id === selectedId) ?? null, [hits, selectedId]);

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

  const columns: Column<ContactHit>[] = useMemo(
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
    ],
    [allShownSelected, shownIds, bulk],
  );

  return (
    <div className={styles.page} data-density={density}>
      <FilterPanel query={query} onChange={setQuery} counts={counts} />

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
              <CardGrid hits={hits} onOpen={setSelectedId} />
            ) : (
              <DataTable
                columns={columns}
                rows={hits}
                rowKey={(c) => c.id}
                onRowClick={(c) => setSelectedId(c.id)}
                isSelected={(c) => c.id === selectedId}
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

      <RecordDetail
        contact={selected}
        onClose={() => setSelectedId(null)}
        onRevealed={(id) => markRevealed(id)}
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
