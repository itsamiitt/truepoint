// CrmSyncMonitorPage.tsx — the staff CRM-sync fleet monitor (crm-sync 00 §9). A cross-tenant operational
// view: every connection's status, mode, token expiry and last error.
//
// IT CARRIES A STANDING CROSS-TENANT NOTICE, the same posture the Forge operator console takes. This page
// spans tenants by construction, every load writes a platform_audit_log row, and an operator should be able
// to see that from the page rather than infer it — a console that hides the fact it is privileged invites
// treating privileged access as routine.
//
// The projection is operational only: no credential, no contact data, nothing derived from tenant records.
"use client";

import {
  Card,
  type Column,
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  StatTile,
  StateSwitch,
  StatusBadge,
  TableSkeleton,
  TpButton,
} from "@leadwolf/ui";
import { classifyConnection, fmtDateTime, needsAttention } from "../format";
import { useCrmSyncHealth } from "../hooks/useCrmSyncHealth";
import type { StaffCrmConnection } from "../types";
import { DeadLetterQueue } from "./DeadLetterQueue";

export function CrmSyncMonitorPage() {
  const { connections, loading, error, reload } = useCrmSyncHealth();
  const list = connections ?? [];
  // Evaluated once per render rather than per row, so every row in a table is classified against the SAME
  // instant — otherwise a token expiring mid-render could be judged differently in two adjacent cells.
  const now = Date.now();
  const attention = needsAttention(list, now);

  const columns: Column<StaffCrmConnection>[] = [
    {
      key: "health",
      header: "Health",
      sortValue: (c) => classifyConnection(c, now).label,
      cell: (c) => {
        const h = classifyConnection(c, now);
        return <StatusBadge tone={h.tone}>{h.label}</StatusBadge>;
      },
    },
    { key: "provider", header: "Provider", sortValue: (c) => c.provider, cell: (c) => c.provider },
    {
      key: "environment",
      header: "Env",
      sortValue: (c) => c.environment,
      cell: (c) => c.environment,
    },
    {
      key: "account",
      header: "CRM account",
      sortValue: (c) => c.externalAccountId ?? "",
      cell: (c) => c.externalAccountId ?? "—",
    },
    {
      key: "workspace",
      header: "Workspace",
      sortValue: (c) => c.workspaceId,
      cell: (c) => c.workspaceId,
    },
    {
      key: "expires",
      header: "Token expires",
      sortValue: (c) => c.tokenExpiresAt ?? "",
      cell: (c) => fmtDateTime(c.tokenExpiresAt),
    },
    {
      key: "refreshed",
      header: "Last refresh",
      sortValue: (c) => c.lastRefreshAt ?? "",
      cell: (c) => fmtDateTime(c.lastRefreshAt),
    },
    {
      key: "error",
      header: "Last error",
      // Truncated: a provider message can be 500 characters and would otherwise dominate the table. The
      // full text is on the connection row for anyone who needs it.
      cell: (c) => (c.lastError ? c.lastError.slice(0, 80) : "—"),
    },
  ];

  return (
    // The header sits OUTSIDE the StateSwitch: inside it, the page lost its title and its Refresh button in
    // exactly the two states where an operator most wants them (still loading, or failed to load).
    <PageContainer width="fluid">
      <PageHeader
        title="CRM sync"
        subtitle="Cross-tenant view — every load is recorded in the platform audit log."
        actions={
          <TpButton variant="secondary" size="sm" onClick={reload}>
            Refresh
          </TpButton>
        }
      />
      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && !error && list.length === 0}
        onRetry={reload}
        skeleton={<TableSkeleton rows={6} columns={[5, 6, 3, 8, 8, 7, 7, 10]} />}
        emptyState={
          <EmptyState
            title="No CRM connections"
            description="No workspace has connected a CRM in this environment yet."
          />
        }
      >
        <Card>
          <StatTile label="Connections" value={list.length.toLocaleString()} />
          <StatTile label="Needs attention" value={attention.length.toLocaleString()} />
          <StatTile
            label="Syncing"
            value={list
              .filter((c) => classifyConnection(c, now).label === "Syncing")
              .length.toLocaleString()}
          />
          <StatTile
            label="Preview only"
            value={list
              .filter((c) => classifyConnection(c, now).label === "Preview")
              .length.toLocaleString()}
          />
        </Card>
        <Card>
          <DataTable columns={columns} rows={list} rowKey={(c) => c.id} />
        </Card>
      </StateSwitch>
      {/* Poison jobs — exhausted retries only, so a row here always needs a human. It loads independently
          and renders its own states, so it stays outside the connections StateSwitch. */}
      <DeadLetterQueue />
    </PageContainer>
  );
}
