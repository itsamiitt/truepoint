// ApprovalsPage.tsx — the maker-checker review queue (database-management-research 09): high-risk Data-management
// operations awaiting a second operator's decision. The FIRST mutation surface in the data-ops area; mirrors
// features/tenants/TenantActions (Dialog + reason + useToast). Approve/reject go to the audited, data:review-gated
// /admin/data/approvals/:id/* endpoints; the SERVER enforces requester != approver (a self-decision is a clean
// 403 surfaced as a toast — the console never assumes the caller may act). On success the queue reloads.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { ApprovalRequestView } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  TpButton,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { approveRequest, rejectRequest } from "../api";
import { shortDate } from "../format";
import { useApprovals } from "../hooks/useApprovals";

const MIN_REASON = 5;

export function ApprovalsPage() {
  const { approvals, loading, error, reload } = useApprovals();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canReview = canMaybe("data:review");

  const [target, setTarget] = useState<ApprovalRequestView | null>(null);
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  function open(t: ApprovalRequestView, m: "approve" | "reject") {
    setTarget(t);
    setMode(m);
    setReason("");
  }

  async function onConfirm() {
    if (!target) return;
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "approve") await approveRequest(target.id, r);
      else await rejectRequest(target.id, r);
      toast.success(mode === "approve" ? "Request approved." : "Request rejected.");
      setTarget(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  const actionsCol: Column<ApprovalRequestView> = {
    key: "actions",
    header: "",
    cell: (r) => (
      <div style={{ display: "flex", gap: 8 }}>
        <TpButton variant="secondary" onClick={() => open(r, "approve")}>
          Approve
        </TpButton>
        <TpButton variant="danger" onClick={() => open(r, "reject")}>
          Reject
        </TpButton>
      </div>
    ),
  };

  const columns: Column<ApprovalRequestView>[] = [
    {
      key: "operation",
      header: "Operation",
      sortValue: (r) => r.operation,
      cell: (r) => <span className="tp-cell-mono">{r.operation}</span>,
    },
    {
      key: "target",
      header: "Target tenant",
      sortValue: (r) => r.targetTenantId ?? "",
      cell: (r) => <span className="tp-cell-mono">{r.targetTenantId ?? "platform-wide"}</span>,
    },
    {
      key: "requestedBy",
      header: "Requested by",
      sortValue: (r) => r.requestedByUserId,
      cell: (r) => <span className="tp-cell-mono">{r.requestedByUserId}</span>,
    },
    { key: "reason", header: "Reason", sortValue: (r) => r.requestReason, cell: (r) => r.requestReason },
    {
      key: "created",
      header: "Filed",
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.createdAt)}</span>,
    },
    {
      key: "expires",
      header: "Expires",
      sortValue: (r) => r.expiresAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.expiresAt)}</span>,
    },
    ...(canReview ? [actionsCol] : []),
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Approvals</h2>
          <p className="tp-page-sub">
            Maker-checker review queue — high-risk data operations awaiting a second operator. You cannot
            decide a request you filed (separation of duties, enforced server-side).
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!approvals && approvals.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No pending approvals"
            description="Nothing is awaiting review."
          />
        }
      >
        <DataTable columns={columns} rows={approvals ?? []} rowKey={(r) => r.id} />
      </StateSwitch>

      <Dialog
        open={target !== null}
        onClose={() => (busy ? undefined : setTarget(null))}
        title={mode === "approve" ? "Approve request" : "Reject request"}
        description={
          target
            ? `${mode === "approve" ? "Approve" : "Reject"} the ${target.operation} request. This is audited.`
            : ""
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant={mode === "approve" ? "primary" : "danger"}
              onClick={() => void onConfirm()}
              disabled={busy}
            >
              {busy ? "Working…" : mode === "approve" ? "Approve" : "Reject"}
            </TpButton>
          </div>
        }
      >
        <label htmlFor="approval-reason" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
          <TpTextarea
            id="approval-reason"
            value={reason}
            rows={3}
            placeholder="Why are you approving / rejecting this request?"
            disabled={busy}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
