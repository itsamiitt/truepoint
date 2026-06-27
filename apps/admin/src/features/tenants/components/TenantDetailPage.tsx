// TenantDetailPage.tsx — one org's detail (13 §3.1): the tenant's plan/limits/region, its workspaces, and its
// members, all read from the api `/admin/tenants/:id` surface. The header carries the staff mutation row
// (TenantActions: suspend/reactivate + manual credit grant/adjustment — 13a Area 1). Renders each async state
// through the shared State Kit.
"use client";

import { Card, type Column, DataTable, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { formatInt, shortDate, statusTone } from "../format";
import { useTenantDetail } from "../hooks/useTenantDetail";
import type { TenantMember, TenantWorkspace } from "../types";
import { SupportNotes } from "./SupportNotes";
import { TenantActions } from "./TenantActions";
import { TenantHolds } from "./TenantHolds";
import { TenantOverview } from "./TenantOverview";
import { TenantPurchases } from "./TenantPurchases";

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="tp-meta-field">
      <span className="tp-meta-label">{label}</span>
      <span className="tp-meta-value">{value}</span>
    </div>
  );
}

export function TenantDetailPage({ tenantId }: { tenantId: string }) {
  const { detail, loading, error, reload } = useTenantDetail(tenantId);

  const workspaceColumns: Column<TenantWorkspace>[] = [
    {
      key: "name",
      header: "Workspace",
      sortValue: (w) => w.name,
      cell: (w) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{w.name}</span>
          <span className="tp-cell-mono">{w.slug}</span>
        </div>
      ),
    },
    {
      key: "default",
      header: "Default",
      cell: (w) => (w.isDefault ? "Yes" : "—"),
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (w) => w.createdAt,
      cell: (w) => <span className="tp-cell-mono">{shortDate(w.createdAt)}</span>,
    },
  ];

  const memberColumns: Column<TenantMember>[] = [
    {
      key: "member",
      header: "Member",
      sortValue: (m) => m.fullName ?? m.email,
      cell: (m) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{m.fullName ?? m.email}</span>
          {m.fullName ? <span className="tp-cell-mono">{m.email}</span> : null}
        </div>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      cell: (m) => (m.isTenantOwner ? "Owner" : "Member"),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (m) => m.status,
      cell: (m) => <StatusBadge tone={statusTone(m.status)}>{m.status}</StatusBadge>,
    },
  ];

  return (
    <div className="tp-page">
      <Link href="/tenants" className="tp-link-back">
        <ArrowLeft size={14} /> Tenants
      </Link>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {detail ? (
          <>
            <div className="tp-page-head">
              <div>
                <h2 className="tp-page-title">{detail.tenant.name}</h2>
                <p className="tp-page-sub">{detail.tenant.slug}</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <StatusBadge tone={statusTone(detail.tenant.status)}>
                  {detail.tenant.status}
                </StatusBadge>
                <TenantActions tenant={detail.tenant} onChanged={reload} />
              </div>
            </div>

            <Card style={{ marginBottom: 24 }}>
              <div className="tp-meta-grid">
                <MetaField label="Plan" value={detail.tenant.plan} />
                <MetaField label="Seat limit" value={formatInt(detail.tenant.seatLimit)} />
                <MetaField
                  label="Workspace limit"
                  value={
                    detail.tenant.workspaceLimit == null
                      ? "Unlimited"
                      : formatInt(detail.tenant.workspaceLimit)
                  }
                />
                <MetaField
                  label="Credit balance"
                  value={formatInt(detail.tenant.revealCreditBalance)}
                />
                <MetaField label="Region" value={detail.tenant.regionDefault} />
                <MetaField label="Created" value={shortDate(detail.tenant.createdAt)} />
              </div>
            </Card>

            <TenantOverview tenantId={tenantId} />

            <h3 className="tp-section-title">Workspaces ({detail.workspaces.length})</h3>
            <DataTable
              columns={workspaceColumns}
              rows={detail.workspaces}
              rowKey={(w) => w.id}
              empty={
                <p className="app-muted" style={{ padding: 16 }}>
                  No workspaces.
                </p>
              }
            />

            <h3 className="tp-section-title" style={{ marginTop: 28 }}>
              Members ({detail.members.length})
            </h3>
            <DataTable
              columns={memberColumns}
              rows={detail.members}
              rowKey={(m) => m.userId}
              empty={
                <p className="app-muted" style={{ padding: 16 }}>
                  No members.
                </p>
              }
            />

            <TenantPurchases tenantId={tenantId} onRefunded={reload} />
            <TenantHolds tenantId={tenantId} />
            <SupportNotes tenantId={tenantId} />
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}
