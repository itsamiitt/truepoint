// DeadLetterQueue.tsx — the staff poison-job triage console (crm-sync 00 §4.8 / §9).
//
// A row here means a job EXHAUSTED its retries: it will never succeed on its own. That is why the table is
// worth a console at all — transient failures never reach it.
//
// WHAT THE ACTIONS DO, AND DELIBERATELY DO NOT: "Mark retrying" records the operator's intent to replay; it
// does NOT re-drive the job. Re-driving spends the customer's CRM quota and can re-attempt a write that
// failed for a reason nobody has diagnosed, so the replay is a separate explicit action rather than a side
// effect of clicking a status. "Resolve" and "Ignore" close the row without touching the CRM.
//
// Nothing here shows the record that failed — the error detail is scrubbed server-side and the ids are
// opaque. A triage console must not become a cross-tenant window onto customer data.
"use client";

import {
  Card,
  type Column,
  DataTable,
  EmptyState,
  Icon,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
} from "@leadwolf/ui";
import { PackageX } from "lucide-react";
import { fmtDateTime } from "../format";
import { useCrmDeadLetters } from "../hooks/useCrmDeadLetters";
import type { StaffCrmDeadLetter } from "../types";

/**
 * Tone by error class. `auth` and `ssrf_blocked` are danger because they are security-shaped: a revoked
 * credential or a blocked outbound target needs a human now. The rest are warnings — real failures, but the
 * kind that a fix-and-replay resolves.
 */
const CLASS_TONE: Record<string, StatusTone> = {
  auth: "danger",
  ssrf_blocked: "danger",
  suppressed: "muted",
  not_found: "muted",
};

export function DeadLetterQueue() {
  const { rows, total, error, loading, busy, reload, triage } = useCrmDeadLetters();
  const list = rows ?? [];
  // PA-12: past the 200-row cap, say so — during an incident the difference between 201 and 200,000 open
  // poison jobs is the whole point of this console.
  const truncated = total !== null && total > list.length;

  const columns: Column<StaffCrmDeadLetter>[] = [
    {
      key: "errorClass",
      header: "Failure",
      sortValue: (r) => r.errorClass,
      cell: (r) => (
        <StatusBadge tone={CLASS_TONE[r.errorClass] ?? "warning"}>{r.errorClass}</StatusBadge>
      ),
    },
    { key: "queue", header: "Lane", sortValue: (r) => r.queue, cell: (r) => r.queue },
    {
      key: "object",
      header: "Object",
      sortValue: (r) => r.objectType ?? "",
      cell: (r) => r.objectType ?? "—",
    },
    {
      key: "workspace",
      header: "Workspace",
      sortValue: (r) => r.workspaceId,
      cell: (r) => r.workspaceId,
    },
    {
      key: "attempts",
      header: "Attempts",
      align: "right",
      sortValue: (r) => r.attempts,
      cell: (r) => r.attempts,
    },
    {
      key: "detail",
      header: "Reason",
      // Truncated: a provider message can be 1000 characters. It is already scrubbed of emails and long
      // digit runs server-side, so this is a width decision, not a privacy one.
      cell: (r) => (r.errorDetail ? r.errorDetail.slice(0, 90) : "—"),
    },
    {
      key: "lastSeen",
      header: "Last seen",
      sortValue: (r) => r.lastSeenAt,
      cell: (r) => fmtDateTime(r.lastSeenAt),
    },
    {
      key: "actions",
      header: "Triage",
      cell: (r) => (
        <>
          <TpButton
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void triage(r.id, "retrying")}
          >
            Mark retrying
          </TpButton>{" "}
          <TpButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void triage(r.id, "resolved")}
          >
            Resolve
          </TpButton>{" "}
          <TpButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void triage(r.id, "ignored")}
          >
            Ignore
          </TpButton>
        </>
      ),
    },
  ];

  return (
    <Card>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!loading && !error && list.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={PackageX} size={28} />}
            title="No poison jobs"
            description="Jobs land here only after their retries are exhausted — an empty queue means every failure so far recovered on its own."
          />
        }
      >
        {truncated ? (
          <p
            className="app-muted"
            style={{ margin: "0 0 var(--tp-space-2)", fontSize: "var(--tp-text-body)" }}
          >
            Showing the newest {list.length} of {total} open dead letters.
          </p>
        ) : null}
        <DataTable columns={columns} rows={list} rowKey={(r) => r.id} />
      </StateSwitch>
    </Card>
  );
}
