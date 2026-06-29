// PricingPage.tsx — the credit-pack pricing catalog (13a Area 5, 13 §3.5, 07 §1A): staff author the packs the
// product sells. A table of packs with create / edit (idempotent on key) and offer / retire toggles, all going
// to the audited, pricing:manage-gated api. Renders async state through the State Kit. The public, transparent
// pricing page (ADR-0012) is a separate customer surface.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Tag } from "lucide-react";
import { type ReactNode, useState } from "react";
import { setCreditPackActive, upsertCreditPack } from "../api";
import { usePricing } from "../hooks/usePricing";
import type { CreditPack } from "../types";

interface Draft {
  editingKey: string | null; // null = creating a new pack
  key: string;
  name: string;
  credits: string;
  priceDollars: string;
  sortOrder: string;
}

const EMPTY: Draft = {
  editingKey: null,
  key: "",
  name: "",
  credits: "",
  priceDollars: "",
  sortOrder: "0",
};

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function PricingPage() {
  const { packs, loading, error, reload } = usePricing();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("pricing:manage");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  function openNew() {
    setDraft({ ...EMPTY });
  }
  function openEdit(p: CreditPack) {
    setDraft({
      editingKey: p.key,
      key: p.key,
      name: p.name,
      credits: String(p.credits),
      priceDollars: (p.priceCents / 100).toString(),
      sortOrder: String(p.sortOrder),
    });
  }

  async function onSave() {
    if (!draft) return;
    const key = draft.key.trim();
    const name = draft.name.trim();
    const credits = Number(draft.credits);
    const price = Number(draft.priceDollars);
    const sortOrder = Number(draft.sortOrder || "0");
    if (!/^[a-z0-9_]+$/.test(key)) {
      toast.error("Key: lowercase letters, digits and underscore only.");
      return;
    }
    if (!name) {
      toast.error("Enter a name.");
      return;
    }
    if (!Number.isInteger(credits) || credits < 1) {
      toast.error("Credits must be a whole number ≥ 1.");
      return;
    }
    if (!(price >= 0) || Number.isNaN(price)) {
      toast.error("Enter a valid price.");
      return;
    }
    setBusy(true);
    try {
      await upsertCreditPack({
        key,
        name,
        credits,
        priceCents: Math.round(price * 100),
        sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0,
      });
      toast.success(draft.editingKey ? "Pack updated." : "Pack created.");
      setDraft(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the pack");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(p: CreditPack) {
    try {
      await setCreditPackActive(p.key, !p.active);
      toast.success(p.active ? "Pack retired." : "Pack offered.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the pack");
    }
  }

  const columns: Column<CreditPack>[] = [
    {
      key: "name",
      header: "Pack",
      sortValue: (p) => p.sortOrder,
      cell: (p) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{p.name}</span>
          <span className="tp-cell-mono">{p.key}</span>
        </div>
      ),
    },
    {
      key: "credits",
      header: "Credits",
      align: "right",
      sortValue: (p) => p.credits,
      cell: (p) => p.credits.toLocaleString(),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortValue: (p) => p.priceCents,
      cell: (p) => money(p.priceCents),
    },
    {
      key: "active",
      header: "Status",
      sortValue: (p) => (p.active ? 0 : 1),
      cell: (p) => (
        <StatusBadge tone={p.active ? "success" : "muted"}>
          {p.active ? "Offered" : "Retired"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        canManage ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="ghost" size="sm" onClick={() => openEdit(p)}>
              Edit
            </TpButton>
            <TpButton variant="ghost" size="sm" onClick={() => void onToggle(p)}>
              {p.active ? "Retire" : "Offer"}
            </TpButton>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Pricing</h2>
          <p className="tp-page-sub">
            The credit-pack catalog the product sells — transparent, public pricing (no demo gate).
          </p>
        </div>
        {canManage ? <TpButton onClick={openNew}>New pack</TpButton> : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!packs && packs.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Tag size={20} />}
            title="No credit packs"
            description="Create the first pack the product will offer."
          />
        }
      >
        <DataTable columns={columns} rows={packs ?? []} rowKey={(p) => p.key} />
      </StateSwitch>

      <Dialog
        open={!!draft}
        onClose={() => (busy ? undefined : setDraft(null))}
        title={draft?.editingKey ? "Edit credit pack" : "New credit pack"}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onSave()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </TpButton>
          </div>
        }
      >
        {draft ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Key (stable id)" htmlFor="pack-key">
              <TpInput
                id="pack-key"
                value={draft.key}
                placeholder="e.g. starter_500"
                disabled={busy || draft.editingKey != null}
                onChange={(e) => setDraft({ ...draft, key: e.currentTarget.value })}
              />
            </Field>
            <Field label="Name" htmlFor="pack-name">
              <TpInput
                id="pack-name"
                value={draft.name}
                placeholder="e.g. Starter — 500 credits"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </Field>
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Credits" htmlFor="pack-credits" grow>
                <TpInput
                  id="pack-credits"
                  type="number"
                  value={draft.credits}
                  placeholder="500"
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, credits: e.currentTarget.value })}
                />
              </Field>
              <Field label="Price (USD)" htmlFor="pack-price" grow>
                <TpInput
                  id="pack-price"
                  type="number"
                  value={draft.priceDollars}
                  placeholder="49.00"
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, priceDollars: e.currentTarget.value })}
                />
              </Field>
              <Field label="Sort" htmlFor="pack-sort">
                <TpInput
                  id="pack-sort"
                  type="number"
                  value={draft.sortOrder}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, sortOrder: e.currentTarget.value })}
                />
              </Field>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function Field({
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
      style={{ display: "flex", flexDirection: "column", gap: 4, flex: grow ? "1 1 0" : undefined }}
    >
      <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}
