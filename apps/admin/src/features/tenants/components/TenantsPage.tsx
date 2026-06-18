// TenantsPage.tsx — the cross-tenant directory (13 §3.1): plan / status / seats / credits per org, read from
// the api `/admin/tenants` surface. Read-only in this phase (staff mutations come later via audited
// endpoints). A row click opens the tenant detail. Renders every async state through the shared State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatInt, shortDate, statusTone } from "../format";
import { useTenants } from "../hooks/useTenants";
import type { TenantRow } from "../types";

export function TenantsPage() {
  const router = useRouter();
  const { tenants, loading, error, reload } = useTenants();

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

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!tenants && tenants.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Building2 size={20} />}
            title="No tenants"
            description="No organizations have been provisioned yet."
          />
        }
      >
        <DataTable
          columns={columns}
          rows={tenants ?? []}
          rowKey={(t) => t.id}
          onRowClick={(t) => router.push(`/tenants/${t.id}`)}
        />
      </StateSwitch>
    </div>
  );
}
