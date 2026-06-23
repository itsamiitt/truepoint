// AuditLogPage.tsx — the platform audit-log viewer (ADR-0032 / 13 §9), read from the api `/admin/audit-log`
// surface. Strictly read-only: the log is an append-only record of every privileged cross-tenant action, so
// there are no row actions. The free-form `metadata` is never fetched. Renders every async state through the
// shared State Kit. Mirrors the Tenants directory structure.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { ScrollText } from "lucide-react";
import { shortDateTime, shortId, targetLabel } from "../format";
import { useAuditLog } from "../hooks/useAuditLog";
import type { PlatformAuditEntry } from "../types";

export function AuditLogPage() {
  const { entries, loading, error, reload } = useAuditLog();

  const columns: Column<PlatformAuditEntry>[] = [
    {
      key: "occurredAt",
      header: "Time",
      sortValue: (e) => e.occurredAt,
      cell: (e) => <span className="tp-cell-mono">{shortDateTime(e.occurredAt)}</span>,
    },
    {
      key: "action",
      header: "Action",
      sortValue: (e) => e.action,
      cell: (e) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{e.action}</span>,
    },
    {
      key: "actor",
      header: "Actor",
      sortValue: (e) => e.actorUserId ?? "",
      cell: (e) => <span className="tp-cell-mono">{shortId(e.actorUserId)}</span>,
    },
    {
      key: "target",
      header: "Target",
      sortValue: (e) => `${e.targetType ?? ""}${e.targetId ?? ""}`,
      cell: (e) => targetLabel(e.targetType, e.targetId),
    },
    {
      key: "tenant",
      header: "Tenant",
      sortValue: (e) => e.tenantId ?? "",
      cell: (e) => <span className="tp-cell-mono">{shortId(e.tenantId)}</span>,
    },
    {
      key: "ip",
      header: "IP",
      sortValue: (e) => e.ip ?? "",
      cell: (e) => <span className="tp-cell-mono">{e.ip ?? "—"}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Audit log</h2>
          <p className="tp-page-sub">
            Recent privileged platform actions across all tenants — append-only, read-only.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!entries && entries.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ScrollText size={20} />}
            title="No audit entries"
            description="No platform actions have been recorded yet."
          />
        }
      >
        <DataTable columns={columns} rows={entries ?? []} rowKey={(e) => e.id} />
      </StateSwitch>
    </div>
  );
}
