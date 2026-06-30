// AuditLogPage.tsx — the platform audit-log viewer (ADR-0032 / 13 §9, 13a F4 / Area 11), read from the api
// `/admin/audit-log` surface. Append-only + read-only (no row actions; `metadata` is never fetched), now with
// AND-combined filters (action / tenant / actor / date range), keyset "Load more" pagination, and an audited
// CSV export. Renders every async state through the shared State Kit.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Download, ScrollText } from "lucide-react";
import { type ReactNode, useState } from "react";
import { exportAuditLog } from "../api";
import { shortDateTime, shortId, targetLabel } from "../format";
import { useAuditLog } from "../hooks/useAuditLog";
import type { AuditLogFilters, PlatformAuditEntry } from "../types";

/** Convert a `<input type="date">` value (YYYY-MM-DD) to the UTC day bound the api expects (ISO datetime). */
function dayStart(date: string): string | undefined {
  return date ? `${date}T00:00:00.000Z` : undefined;
}
function dayEnd(date: string): string | undefined {
  return date ? `${date}T23:59:59.999Z` : undefined;
}

export function AuditLogPage() {
  const {
    entries,
    nextCursor,
    filters,
    loading,
    loadingMore,
    loadMoreError,
    error,
    applyFilters,
    loadMore,
    reload,
  } = useAuditLog();
  const toast = useToast();

  const [action, setAction] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [exporting, setExporting] = useState(false);

  function onApply() {
    const f: AuditLogFilters = {
      action: action.trim() || undefined,
      tenantId: tenantId.trim() || undefined,
      actorUserId: actorUserId.trim() || undefined,
      since: dayStart(since),
      until: dayEnd(until),
    };
    applyFilters(f);
  }

  function onReset() {
    setAction("");
    setTenantId("");
    setActorUserId("");
    setSince("");
    setUntil("");
    applyFilters({});
  }

  async function onExport() {
    setExporting(true);
    try {
      await exportAuditLog(filters);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

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
            Privileged platform actions across all tenants — append-only, read-only. Filter and
            export for review.
          </p>
        </div>
        <TpButton variant="secondary" onClick={() => void onExport()} disabled={exporting}>
          <Download size={14} /> {exporting ? "Exporting…" : "Export CSV"}
        </TpButton>
      </div>

      {/* Filter bar — all AND-combined; blanks are ignored. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <FilterField label="Action" htmlFor="audit-f-action" grow>
          <TpInput
            id="audit-f-action"
            value={action}
            placeholder="e.g. tenant.suspend"
            onChange={(e) => setAction(e.currentTarget.value)}
          />
        </FilterField>
        <FilterField label="Tenant id" htmlFor="audit-f-tenant" grow>
          <TpInput
            id="audit-f-tenant"
            value={tenantId}
            placeholder="tenant UUID"
            onChange={(e) => setTenantId(e.currentTarget.value)}
          />
        </FilterField>
        <FilterField label="Actor id" htmlFor="audit-f-actor" grow>
          <TpInput
            id="audit-f-actor"
            value={actorUserId}
            placeholder="user UUID"
            onChange={(e) => setActorUserId(e.currentTarget.value)}
          />
        </FilterField>
        <FilterField label="From" htmlFor="audit-f-since">
          <TpInput
            id="audit-f-since"
            type="date"
            value={since}
            onChange={(e) => setSince(e.currentTarget.value)}
          />
        </FilterField>
        <FilterField label="To" htmlFor="audit-f-until">
          <TpInput
            id="audit-f-until"
            type="date"
            value={until}
            onChange={(e) => setUntil(e.currentTarget.value)}
          />
        </FilterField>
        <TpButton onClick={onApply}>Apply</TpButton>
        <TpButton variant="ghost" onClick={onReset}>
          Reset
        </TpButton>
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
            description="No platform actions match the current filters."
          />
        }
      >
        <DataTable columns={columns} rows={entries ?? []} rowKey={(e) => e.id} />
        {nextCursor ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              marginTop: 16,
            }}
          >
            {loadMoreError ? (
              <span style={{ color: "var(--danger)", fontSize: 13 }}>{loadMoreError}</span>
            ) : null}
            <TpButton variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : loadMoreError ? "Retry" : "Load more"}
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}

function FilterField({
  label,
  htmlFor,
  grow,
  children,
}: {
  label: string;
  htmlFor: string;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flex: grow ? "1 1 180px" : undefined,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}
