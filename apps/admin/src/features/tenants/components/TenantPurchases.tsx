// TenantPurchases.tsx — the billing/purchases panel on a tenant's detail (13a Area 4, 13 §3.4): the tenant's
// credit-pack purchases and an audited refund. Visible only to billing:read; a refund needs tenants:credits
// (the button hides otherwise; the api still enforces it). The refund reverses credits (clamped to the
// available balance) and marks the purchase refunded; on success the parent reloads so the header balance
// updates. Renders async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { RefundReason } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  Dialog,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchTenantPurchases, refundPurchase } from "../api";
import { shortDate } from "../format";
import type { Purchase } from "../types";

function money(cents: number | null): string {
  return cents == null
    ? "—"
    : (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

const REFUND_REASONS: { value: RefundReason; label: string }[] = [
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraud", label: "Fraud" },
  { value: "billing_error", label: "Billing error" },
  { value: "goodwill", label: "Goodwill" },
  { value: "other", label: "Other" },
];

export function TenantPurchases({
  tenantId,
  onRefunded,
}: {
  tenantId: string;
  onRefunded: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");
  const canRefund = canMaybe("tenants:credits");

  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<Purchase | null>(null);
  const [reason, setReason] = useState<RefundReason>("duplicate");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPurchases(await fetchTenantPurchases(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load purchases");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  // Hide the whole section once we know the caller can't view billing (the api also enforces it).
  if (loaded && !canView) return null;

  async function onConfirmRefund() {
    if (!confirm) return;
    if (reason === "other" && !note.trim()) {
      toast.error("Add a note explaining the refund.");
      return;
    }
    setBusy(true);
    try {
      // Money moves require peer approval (Part B / decision #4): FILE a request — a different operator approves
      // + executes the reversal. The purchase stays un-refunded until then.
      await refundPurchase(tenantId, confirm.id, reason, note.trim() || undefined);
      toast.success("Refund requested — a different operator must approve it before it applies.");
      setConfirm(null);
      await onRefunded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Purchase>[] = [
    {
      key: "createdAt",
      header: "Date",
      sortValue: (p) => p.createdAt,
      cell: (p) => <span className="tp-cell-mono">{shortDate(p.createdAt)}</span>,
    },
    {
      key: "credits",
      header: "Credits",
      align: "right",
      sortValue: (p) => p.credits,
      cell: (p) => p.credits.toLocaleString(),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortValue: (p) => p.amountCents ?? 0,
      cell: (p) => money(p.amountCents),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (p) => p.status,
      cell: (p) => (
        <StatusBadge tone={p.status === "refunded" ? "muted" : "success"}>{p.status}</StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        canRefund && p.status !== "refunded" ? (
          <TpButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setReason("duplicate");
              setNote("");
              setConfirm(p);
            }}
          >
            Refund
          </TpButton>
        ) : null,
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Purchases</h3>
      <StateSwitch
        loading={loading}
        error={error}
        empty={!!purchases && purchases.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No purchases.
          </p>
        }
      >
        <DataTable columns={columns} rows={purchases ?? []} rowKey={(p) => p.id} />
      </StateSwitch>

      <Dialog
        open={!!confirm}
        onClose={() => (busy ? undefined : setConfirm(null))}
        title="Refund purchase"
        description={
          confirm
            ? `Reverse ${confirm.credits} credits (${money(confirm.amountCents)}) and mark the purchase refunded. Credits are clamped to the available balance. This is audited.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={() => void onConfirmRefund()} disabled={busy}>
              {busy ? "Refunding…" : "Refund"}
            </TpButton>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label
            htmlFor="refund-reason"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason</span>
            <TpSelect
              id="refund-reason"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value as RefundReason)}
            >
              {REFUND_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </TpSelect>
          </label>
          <label htmlFor="refund-note" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>
              Note {reason === "other" ? "(required)" : "(optional)"}
            </span>
            <TpInput
              id="refund-note"
              value={note}
              placeholder="Context for the audit trail"
              disabled={busy}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}
