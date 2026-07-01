// TenantMoneyApprovals.tsx — the maker-checker CHECKER surface on a tenant's detail (Part B / owner decision
// #4): the pending credit-grant/adjust + refund requests a DIFFERENT operator must approve before they apply.
// billing:read to view; tenants:credits to decide. Separation of duties (you can't decide your own request) is
// enforced server-side — a self-approval attempt returns 403, surfaced as a toast. On a decision the parent
// reloads so the balance (approve) reflects it.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { ApprovalRequestView } from "@leadwolf/types";
import { Dialog, StateSwitch, StatusBadge, TpButton, TpTextarea, useToast } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { approveBillingRequest, fetchBillingApprovals, rejectBillingRequest } from "../api";
import { shortDate } from "../format";

const MIN_REASON = 3;

function describe(a: ApprovalRequestView): string {
  if (a.operation === "credit_adjust") {
    const delta = Number((a.params as { delta?: number }).delta ?? 0);
    return `Credit ${delta > 0 ? "grant" : "debit"} of ${Math.abs(delta).toLocaleString()}`;
  }
  if (a.operation === "credit_refund") return "Purchase refund";
  return a.operation;
}

export function TenantMoneyApprovals({
  tenantId,
  onDecided,
}: {
  tenantId: string;
  onDecided: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");
  const canDecide = canMaybe("tenants:credits");

  const [rows, setRows] = useState<ApprovalRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ id: string; kind: "approve" | "reject" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await fetchBillingApprovals();
      setRows(all.filter((a) => a.targetTenantId === tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  async function onSubmit() {
    if (!decision) return;
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      if (decision.kind === "approve") {
        await approveBillingRequest(decision.id, r);
        toast.success("Approved — the change has been applied.");
      } else {
        await rejectBillingRequest(decision.id, r);
        toast.success("Request rejected.");
      }
      setDecision(null);
      setReason("");
      await reload();
      await onDecided();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  if (loaded && !canView) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Pending money approvals</h3>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        empty={!loading && rows.length === 0}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No pending credit or refund requests.
          </p>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                padding: "12px 16px",
                border: "1px solid var(--tp-border)",
                borderRadius: 8,
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{describe(a)}</div>
                <div className="app-muted" style={{ fontSize: 12 }}>
                  {a.requestReason} · filed {shortDate(a.createdAt)}
                </div>
              </div>
              {canDecide ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <TpButton
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setDecision({ id: a.id, kind: "approve" });
                      setReason("");
                    }}
                  >
                    Approve
                  </TpButton>
                  <TpButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDecision({ id: a.id, kind: "reject" });
                      setReason("");
                    }}
                  >
                    Reject
                  </TpButton>
                </div>
              ) : (
                <StatusBadge tone="warning">pending</StatusBadge>
              )}
            </div>
          ))}
        </div>
      </StateSwitch>

      {decision ? (
        <Dialog
          open
          onClose={() => (busy ? undefined : setDecision(null))}
          title={decision.kind === "approve" ? "Approve request" : "Reject request"}
          description="You cannot decide a request you filed yourself — the server enforces separation of duties (a self-decision is refused)."
          footer={
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <TpButton variant="secondary" onClick={() => setDecision(null)} disabled={busy}>
                Cancel
              </TpButton>
              <TpButton
                variant={decision.kind === "approve" ? "primary" : "danger"}
                onClick={() => void onSubmit()}
                disabled={busy}
              >
                {busy ? "Working…" : decision.kind === "approve" ? "Approve" : "Reject"}
              </TpButton>
            </div>
          }
        >
          <label
            htmlFor="money-approval-reason"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
            <TpTextarea
              id="money-approval-reason"
              value={reason}
              rows={3}
              placeholder="e.g. verified the goodwill credit with the account owner"
              disabled={busy}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </label>
        </Dialog>
      ) : null}
    </div>
  );
}
