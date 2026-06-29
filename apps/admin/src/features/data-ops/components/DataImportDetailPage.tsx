// DataImportDetailPage.tsx — one bulk-import job's drill-down (database-management-research Phase 1D), read from
// the api `/admin/data/imports/:jobId` surface. Shows the control-row metadata + denormalized outcome tallies +
// a per-status CHUNK tally so an operator can see WHERE a cross-tenant import stalled or failed. READ-ONLY,
// COUNTS only — no imported row contents. Statuses render as plain text (no tone mapping needed here); every
// async state goes through the shared State Kit.
"use client";

import { type Column, DataTable, StatTile, StateSwitch } from "@leadwolf/ui";
import Link from "next/link";
import { formatInt } from "../format";
import { useDataImportDetail } from "../hooks/useDataImportDetail";
import type { ImportChunkTally } from "../types";

export function DataImportDetailPage({ jobId }: { jobId: string }) {
  const { detail, loading, error, reload } = useDataImportDetail(jobId);

  const chunkColumns: Column<ImportChunkTally>[] = [
    {
      key: "status",
      header: "Chunk status",
      sortValue: (r) => r.status,
      cell: (r) => <span className="tp-cell-mono">{r.status}</span>,
    },
    {
      key: "count",
      header: "Chunks",
      align: "right",
      sortValue: (r) => r.count,
      cell: (r) => formatInt(r.count),
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Import job</h2>
          <p className="tp-page-sub">
            <Link href="/data-ops">Data management</Link> — job metadata and per-chunk progress. Counts only.
          </p>
        </div>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {detail ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 16,
              }}
            >
              <StatTile label="Tenant" value={detail.tenantName} sublabel={detail.tenantId} />
              <StatTile label="Status" value={detail.status} sublabel={detail.sourceName} />
              <StatTile
                label="Rows total"
                value={formatInt(detail.rowsTotal)}
                sublabel={`${formatInt(detail.completedChunks)} / ${formatInt(detail.totalChunks)} chunks done`}
              />
              <StatTile label="Created" value={formatInt(detail.rowsCreated)} />
              <StatTile label="Matched" value={formatInt(detail.rowsMatched)} />
              <StatTile label="Duplicate" value={formatInt(detail.rowsDuplicate)} />
              <StatTile label="Skipped" value={formatInt(detail.rowsSkipped)} />
              <StatTile label="Rejected" value={formatInt(detail.rowsRejected)} />
            </div>

            {detail.failedReason ? (
              <div style={{ color: "var(--tp-ink-3)", fontSize: 13 }}>
                Failure reason: {detail.failedReason}
              </div>
            ) : null}

            <div>
              <div
                style={{
                  color: "var(--tp-ink)",
                  fontSize: 14,
                  fontWeight: 600,
                  marginBottom: 8,
                }}
              >
                Chunks by status
              </div>
              <DataTable columns={chunkColumns} rows={detail.chunkTally} rowKey={(r) => r.status} />
            </div>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
