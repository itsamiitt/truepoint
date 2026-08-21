// CompaniesIndexPage.tsx — the /companies destination's index (market-intelligence MI-1 second half,
// 07-product-surfaces §1): the account-search surface as its OWN destination. Reuses the prospect
// slice's account engine wholesale (useAccountSearch is URL-driven on aq/asort/af, so views stay
// shareable): filter rail + free-text + grid. A row opens the routed company page — the drawer stays a
// Prospect-search preview affordance. The Prospect page's Accounts toggle remains until the cutover
// step retires it with redirects (00-progress).
"use client";

import {
  AccountFilterPanel,
  AccountsTable,
  useAccountFacetCounts,
  useAccountSearch,
} from "@/features/prospect/entries/accounts";
import type { AccountFacetKey } from "@leadwolf/types";
import { EmptyState, StateSwitch, TpButton } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "../companies.module.css";

const COUNT_FIELDS: AccountFacetKey[] = [
  "industry",
  "company_stage",
  "funding_stage",
  "revenue_range",
  "employee_band",
];

export function CompaniesIndexPage() {
  const router = useRouter();
  const search = useAccountSearch();
  const counts = useAccountFacetCounts(search.query, COUNT_FIELDS);

  // The same debounce-commit free-text pattern as the Prospect page's account box.
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
    <section className={styles.indexLayout}>
      <AccountFilterPanel query={search.query} onChange={search.setQuery} counts={counts} />
      <div className={styles.indexMain}>
        <div className={styles.indexHead}>
          <h1 className="tp-settings-title" style={{ margin: 0 }}>
            Companies
          </h1>
          <input
            className={styles.searchInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search companies…"
            aria-label="Search companies"
          />
          <Link href="/companies/markets" className={styles.marketsLink}>
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
      </div>
    </section>
  );
}
