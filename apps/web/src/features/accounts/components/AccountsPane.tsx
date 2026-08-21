// AccountsPane.tsx — the Accounts half of the Search surface (search-consolidation 01).
//
// It is the company-level sibling of PeoplePane and renders the SAME shell grid: the collapsible filter
// drawer on the left (hosting the People/Accounts switch and this pane's firmographic filter panel), the
// results grid on the right. Search state is URL-driven through useAccountSearch's own `aq`/`asort`/`af`
// codec, which is deliberately separate from the People codec — that is what lets both tabs keep their
// filters in one URL while only one is showing.
//
// SCOPE, STAGE 2: the pane searches the workspace's own `accounts` AND the GLOBAL company graph
// (`master_companies`) in one list, with "already in my workspace" as a STATE of a row — the same shape the
// People tab has had since Layer-0-as-database. The global half is behind DATABASE_COMPANY_SEARCH_ENABLED
// and degrades to workspace-only, honestly labelled, while the gate is off.
"use client";

import {
  AppliedFilterChips,
  SearchDrawer,
  SearchDrawerOpener,
  type SearchShell,
  WorkspaceScopeControl,
} from "@/components/search";
import shellStyles from "@/components/search/search.module.css";
import {
  AccountFilterPanel,
  AccountsTable,
  activeChips,
  clearAllFilters,
  useAccountFacetCounts,
} from "@/features/prospect/entries/accounts";
import type { AccountFacetKey, MaskedAccount } from "@leadwolf/types";
import { EmptyState, StateSwitch, TpButton, TpInput } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AccountRow } from "../accountRows";
import styles from "../accounts.module.css";
import { exportAccountsCsv } from "../export";
import { useAccountsSearch } from "../hooks/useAccountsSearch";

/** The fixed-option firmographic facets that get live counts in the rail (POST /account-search/facets). */
const COUNT_FIELDS: AccountFacetKey[] = [
  "industry",
  "company_stage",
  "funding_stage",
  "revenue_range",
  "employee_band",
];

export function AccountsPane({ shell }: { shell: SearchShell }) {
  const router = useRouter();
  const search = useAccountsSearch({
    includeDatabase: shell.workspace.includeDatabase,
    excludeOwned: !shell.workspace.includeOwned,
  });
  const counts = useAccountFacetCounts(search.query, COUNT_FIELDS);

  // The same debounce-commit free-text pattern the People pane uses: a local mirror committed to the query
  // 300ms after the last keystroke, re-synced when the query changes externally (URL restore / back).
  const [text, setText] = useState(search.query.text ?? "");
  useEffect(() => setText(search.query.text ?? ""), [search.query.text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce-commit keyed on the local input.
  useEffect(() => {
    const t = text.trim();
    if (t === (search.query.text ?? "")) return;
    const id = setTimeout(() => search.setQuery({ ...search.query, text: t || undefined }), 300);
    return () => clearTimeout(id);
  }, [text]);

  return (
    <div className={shellStyles.page} data-collapsed={shell.collapsed}>
      <SearchDrawer
        collapsed={shell.collapsed}
        isOverlay={shell.isOverlay}
        onToggle={shell.toggle}
        onClose={shell.close}
        tabs={shell.tabs}
      >
        <AccountFilterPanel query={search.query} onChange={search.setQuery} counts={counts} />
      </SearchDrawer>

      <section className={styles.indexMain}>
        <div className={styles.indexHead}>
          {/* Only visible while the rail is off-canvas (≤768px, collapsed). */}
          <SearchDrawerOpener onOpen={shell.toggle} />
          <TpInput
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search companies by name or domain…"
            aria-label="Search companies"
          />
          <WorkspaceScopeControl
            scope={shell.workspace.scope}
            onChange={shell.workspace.setScope}
          />
          <TpButton
            variant="ghost"
            size="sm"
            disabled={search.rows.length === 0}
            onClick={() => exportAccountsCsv(search.rows)}
          >
            Export CSV
          </TpButton>
          <Link href="/search/markets" className={styles.marketsLink}>
            Markets →
          </Link>
        </div>

        <AppliedFilterChips
          chips={activeChips(search.query)}
          query={search.query}
          onChange={search.setQuery}
          onClearAll={() => search.setQuery(clearAllFilters(search.query))}
        />

        <div className={styles.resultCount}>
          {search.loading
            ? "Loading…"
            : `${(search.rows.length - search.databaseCount).toLocaleString()} in your workspace${
                search.databaseTotal !== undefined && search.databaseTotal > 0
                  ? ` · ${search.databaseTotal.toLocaleString()}${
                      search.databaseCapped ? "+" : ""
                    } more in the database`
                  : ""
              }`}
        </div>

        <StateSwitch
          loading={search.loading}
          error={search.error}
          empty={!search.loading && search.rows.length === 0}
          onRetry={search.reload}
          emptyState={
            <EmptyState
              icon={<Building2 size={28} />}
              title="No companies"
              description={
                search.databaseDisabled
                  ? "No accounts in your workspace match this search. Company database search is not enabled yet, so only your own accounts are searched."
                  : "No companies match this search. Adjust your firmographic filters or import more from the Import surface."
              }
            />
          }
        >
          <AccountsTable
            accounts={search.rows}
            loading={search.loading}
            isDatabaseRow={(a) => (a as AccountRow).databaseDomain !== undefined}
            // STAGE 3 — the un-gate. A database row now opens its full masked profile in a drawer instead
            // of being inert; adding it to the workspace is one action ON that profile, not the price of
            // admission to it. An owned account still routes to its own page until that becomes a drawer.
            onOpen={(account: MaskedAccount) => {
              const domain = (account as AccountRow).databaseDomain;
              if (domain !== undefined) shell.openProfile("company", domain);
              else router.push(`/companies/${account.id}`);
            }}
            density="comfortable"
          />
          {search.hasMore && (
            <div className={styles.loadMore}>
              <TpButton
                variant="secondary"
                size="sm"
                loading={search.loading}
                onClick={search.loadMore}
              >
                Load more
              </TpButton>
            </div>
          )}
        </StateSwitch>
      </section>
    </div>
  );
}
