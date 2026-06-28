// VerificationBreakdown.tsx — email + phone verification distribution for the Overview tab: two DataTables built
// ONLY from the WorkspaceDataQuality status counts that exist (email: valid/risky/catch_all/invalid/unknown/
// unverified; phone: valid/invalid + mobile/landline/voip line types). Each row pairs a StatusBadge (text + tone,
// never colour alone) with its count + channel share. Four async states via StateSwitch.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  Icon,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import styles from "../data-health.module.css";
import type { WorkspaceDataQuality } from "../types";

interface StatusRow {
  key: string;
  label: string;
  count: number;
  tone: StatusTone;
}

function emailRows(m: WorkspaceDataQuality): StatusRow[] {
  return [
    { key: "valid", label: "Valid", count: m.emailValid, tone: "success" },
    { key: "risky", label: "Risky", count: m.emailRisky, tone: "warning" },
    { key: "catch_all", label: "Catch-all", count: m.emailCatchAll, tone: "warning" },
    { key: "invalid", label: "Invalid", count: m.emailInvalid, tone: "danger" },
    { key: "unknown", label: "Unknown", count: m.emailUnknown, tone: "muted" },
    { key: "unverified", label: "Unverified", count: m.emailUnverified, tone: "muted" },
  ];
}

function phoneRows(m: WorkspaceDataQuality): StatusRow[] {
  return [
    { key: "valid", label: "Valid", count: m.phoneValid, tone: "success" },
    { key: "invalid", label: "Invalid", count: m.phoneInvalid, tone: "danger" },
    { key: "mobile", label: "Mobile", count: m.phoneMobile, tone: "success" },
    { key: "landline", label: "Landline", count: m.phoneLandline, tone: "muted" },
    { key: "voip", label: "VoIP", count: m.phoneVoip, tone: "muted" },
  ];
}

function StatusTable({ caption, rows, denom }: { caption: string; rows: StatusRow[]; denom: number }) {
  const columns: Column<StatusRow>[] = [
    { key: "label", header: "Status", cell: (r) => <StatusBadge tone={r.tone}>{r.label}</StatusBadge> },
    {
      key: "count",
      header: "Contacts",
      align: "right",
      sortValue: (r) => r.count,
      cell: (r) => r.count.toLocaleString(),
    },
    {
      key: "share",
      header: "Share",
      align: "right",
      sortValue: (r) => r.count,
      cell: (r) => `${denom > 0 ? Math.round((r.count / denom) * 100) : 0}%`,
    },
  ];
  return (
    <div className={styles.tableBlock}>
      <h3 className={styles.subheading}>{caption}</h3>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} />
    </div>
  );
}

export function VerificationBreakdown({
  metrics,
  loading,
  error,
  onRetry,
}: {
  metrics: WorkspaceDataQuality | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const total = metrics?.total ?? 0;
  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && total === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={ShieldCheck} size={28} />}
          title="No contacts yet"
          description="Email and phone verification status appears once contacts are in this workspace."
        />
      }
    >
      {metrics ? (
        <div className={styles.stack}>
          <StatusTable caption="Email verification" rows={emailRows(metrics)} denom={metrics.withEmail} />
          <StatusTable
            caption="Phone verification & line type"
            rows={phoneRows(metrics)}
            denom={metrics.withPhone}
          />
          <p className={styles.footnote}>
            Email rows partition contacts that have an email; phone rows show both the verification
            verdict and the line type, so their shares may overlap.
          </p>
        </div>
      ) : null}
    </StateSwitch>
  );
}
