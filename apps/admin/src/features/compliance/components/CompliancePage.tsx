// CompliancePage.tsx — the compliance-ops DSAR oversight (13a Area 8, 13 §3.8): the data-subject request queue
// across the platform, by status. Read-only and PRIVACY-PRESERVING — the subject email is never surfaced; the
// queue shows the request envelope (type / state / timestamps) only. Renders async state through the State Kit.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpSelect,
} from "@leadwolf/ui";
import { ShieldAlert } from "lucide-react";
import { useCompliance } from "../hooks/useCompliance";
import type { DsarRequest } from "../types";
import { RetentionPolicies } from "./RetentionPolicies";

const STATUSES = ["received", "verifying", "processing", "completed", "rejected"];

function statusTone(status: string): StatusTone {
  if (status === "completed") return "success";
  if (status === "rejected") return "danger";
  if (status === "processing" || status === "verifying") return "warning";
  return "muted";
}

function shortDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
}

export function CompliancePage() {
  const { dsars, status, loading, error, setStatus, reload } = useCompliance();

  const columns: Column<DsarRequest>[] = [
    {
      key: "requestedAt",
      header: "Requested",
      sortValue: (d) => d.requestedAt,
      cell: (d) => <span className="tp-cell-mono">{shortDateTime(d.requestedAt)}</span>,
    },
    {
      key: "type",
      header: "Type",
      sortValue: (d) => d.requestType,
      cell: (d) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{d.requestType}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (d) => d.status,
      cell: (d) => <StatusBadge tone={statusTone(d.status)}>{d.status}</StatusBadge>,
    },
    {
      key: "verified",
      header: "Verified",
      sortValue: (d) => d.verifiedAt ?? "",
      cell: (d) => <span className="tp-cell-mono">{shortDateTime(d.verifiedAt)}</span>,
    },
    {
      key: "completed",
      header: "Completed",
      sortValue: (d) => d.completedAt ?? "",
      cell: (d) => <span className="tp-cell-mono">{shortDateTime(d.completedAt)}</span>,
    },
    {
      key: "id",
      header: "Request",
      sortValue: (d) => d.id,
      cell: (d) => <span className="tp-cell-mono">{d.id.slice(0, 8)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Compliance</h2>
          <p className="tp-page-sub">
            DSAR oversight — the data-subject request queue across the platform. Subject identity is
            never shown here.
          </p>
        </div>
        <TpSelect
          aria-label="Status filter"
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </TpSelect>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!dsars && dsars.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="No DSAR requests"
            description="No data-subject requests match the current filter."
          />
        }
      >
        <DataTable columns={columns} rows={dsars ?? []} rowKey={(d) => d.id} />
      </StateSwitch>

      <RetentionPolicies />
    </div>
  );
}
