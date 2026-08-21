// AccountsPane.tsx — the Accounts half of the Search surface (search-consolidation 01).
//
// It is the company-level sibling of PeoplePane and renders the SAME shell grid: the collapsible filter
// drawer on the left (hosting the People/Accounts switch and this pane's firmographic filter panel), the
// results grid on the right. Search state is URL-driven through useAccountSearch's own `aq`/`asort`/`af`
// codec, which is deliberately separate from the People codec — that is what lets both tabs keep their
// filters in one URL while only one is showing.
//
// SCOPE, STAGE 1: this pane currently searches the WORKSPACE's own `accounts` (what the retired /companies
// index searched). The operator decision is that the Accounts tab searches the GLOBAL company graph
// (`master_companies`) with workspace accounts appearing inside it as a row state — that is stage 2, gated
// behind DATABASE_COMPANY_SEARCH_ENABLED. See docs/planning/search-consolidation/02-backend-spec.md.
"use client";

import { SearchDrawer, SearchDrawerOpener, type SearchShell } from "@/components/search";
import shellStyles from "@/components/search/search.module.css";
import {
  AccountFilterPanel,
  AccountsTable,
  useAccountFacetCounts,
  useAccountSearch,
} from "@/features/prospect";
import type { AccountFacetKey } from "@leadwolf/types";
import { EmptyState, StateSwitch, TpButton, TpInput } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "../accounts.module.css";

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
  const search = useAccountSearch();
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
          <Link href="/search/markets" className={styles.marketsLink}>
            Markets →
          </Link>
        </div>

        <StateSwitch
          loading={search.loading}
          error={search.error}
          empty={!search.loading && search.accounts.length === 0}
          onRetry={search.reload}
          emptyState={
            <EmptyState
              icon={<Building2 size={28} />}
              title="No companies"
              description="No accounts match this search. Adjust your firmographic filters or import more from the Import surface."
            />
          }
        >
          <AccountsTable
            accounts={search.accounts}
            loading={search.loading}
            // STAGE 1: the owned-account profile is still its own route. Stage 3 turns it into a drawer
            // addressed by `?account=<uuid>` on this surface, at which point /companies/:id becomes a
            // redirect like the rest of the retired destination.
            onOpen={(account) => router.push(`/companies/${account.id}`)}
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
