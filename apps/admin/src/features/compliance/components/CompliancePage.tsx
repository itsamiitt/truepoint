// CompliancePage.tsx — the compliance-ops DSAR oversight (13a Area 8, 13 §3.8): the data-subject request queue
// across the platform, by status. Read-only and PRIVACY-PRESERVING — the subject email is never surfaced; the
// queue shows the request envelope (type / state / timestamps) only. Renders async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
  TpSelect,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { transitionDsar } from "../api";
import { useCompliance } from "../hooks/useCompliance";
import type { DsarRequest } from "../types";
import { GlobalSuppression } from "./GlobalSuppression";
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
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("compliance:manage");
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<DsarRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function transition(
    d: DsarRequest,
    next: "verifying" | "processing" | "rejected",
    reason?: string,
  ) {
    setBusyId(d.id);
    try {
      await transitionDsar(d.id, next, reason);
      toast.success(`DSAR marked ${next}.`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the DSAR");
    } finally {
      setBusyId(null);
    }
  }

  async function onReject() {
    if (!rejecting) return;
    const r = rejectReason.trim();
    if (r.length < 3) {
      toast.error("Enter a rejection reason (min 3 characters).");
      return;
    }
    await transition(rejecting, "rejected", r);
    setRejecting(null);
    setRejectReason("");
  }

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
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (d) => {
        const terminal = d.status === "completed" || d.status === "rejected";
        if (!canManage || terminal) return null;
        const busy = busyId === d.id;
        return (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            {d.status === "received" ? (
              <TpButton
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void transition(d, "verifying")}
              >
                Verify
              </TpButton>
            ) : null}
            {d.status === "received" || d.status === "verifying" ? (
              <TpButton
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void transition(d, "processing")}
              >
                Process
              </TpButton>
            ) : null}
            <TpButton variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(d)}>
              Reject
            </TpButton>
          </div>
        );
      },
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

      <Dialog
        open={!!rejecting}
        onClose={() => !busyId && setRejecting(null)}
        title="Reject DSAR request"
        description="Recorded with your reason in the audit log. Rejection closes the request; it does not delete any data."
        maxWidth={480}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setRejecting(null)} disabled={!!busyId}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={() => void onReject()} disabled={!!busyId}>
              {busyId ? "Rejecting…" : "Reject"}
            </TpButton>
          </div>
        }
      >
        <TpTextarea
          aria-label="Rejection reason"
          value={rejectReason}
          rows={3}
          placeholder="Why is this request being rejected? (e.g. identity not verified, not a valid subject)"
          onChange={(e) => setRejectReason(e.currentTarget.value)}
        />
      </Dialog>

      <GlobalSuppression />
      <RetentionPolicies />
    </div>
  );
}
