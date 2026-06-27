// TenantsPage.tsx — the cross-tenant directory (13 §3.1): plan / status / seats / credits per org, read from
// the api `/admin/tenants` surface, with a server-side name/slug search + keyset "Load more" pagination (13a
// F5). A row click opens the tenant detail. Renders every async state through the shared State Kit.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
} from "@leadwolf/ui";
import { Building2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInt, shortDate, statusTone } from "../format";
import { useTenants } from "../hooks/useTenants";
import type { TenantRow } from "../types";

export function TenantsPage() {
  const router = useRouter();
  const { tenants, nextCursor, loading, loadingMore, error, applySearch, loadMore, reload } =
    useTenants();
  const [query, setQuery] = useState("");

  const columns: Column<TenantRow>[] = [
    {
      key: "name",
      header: "Tenant",
      sortValue: (t) => t.name,
      cell: (t) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.name}</span>
          <span className="tp-cell-mono">{t.slug}</span>
        </div>
      ),
    },
    { key: "plan", header: "Plan", sortValue: (t) => t.plan, cell: (t) => t.plan },
    {
      key: "status",
      header: "Status",
      sortValue: (t) => t.status,
      cell: (t) => <StatusBadge tone={statusTone(t.status)}>{t.status}</StatusBadge>,
    },
    {
      key: "seatLimit",
      header: "Seats",
      align: "right",
      sortValue: (t) => t.seatLimit,
      cell: (t) => formatInt(t.seatLimit),
    },
    {
      key: "credits",
      header: "Credits",
      align: "right",
      sortValue: (t) => t.revealCreditBalance,
      cell: (t) => formatInt(t.revealCreditBalance),
    },
    {
      key: "region",
      header: "Region",
      sortValue: (t) => t.regionDefault,
      cell: (t) => t.regionDefault,
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (t) => t.createdAt,
      cell: (t) => <span className="tp-cell-mono">{shortDate(t.createdAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Tenants</h2>
          <p className="tp-page-sub">
            Cross-tenant directory — plan, status, seats and credits per org.
          </p>
        </div>
      </div>

      {/* Server-side search over name / slug; Enter or the button applies it. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          applySearch(query.trim());
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16, maxWidth: 420 }}
      >
        <TpInput
          value={query}
          placeholder="Search by name or slug…"
          aria-label="Search tenants"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <TpButton type="submit" variant="secondary">
          <Search size={14} /> Search
        </TpButton>
      </form>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!tenants && tenants.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Building2 size={20} />}
            title="No tenants"
            description="No organizations match the current search."
          />
        }
      >
        <DataTable
          columns={columns}
          rows={tenants ?? []}
          rowKey={(t) => t.id}
          onRowClick={(t) => router.push(`/tenants/${t.id}`)}
        />
        {nextCursor ? (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
            <TpButton variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
