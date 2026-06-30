// GlobalSuppression.tsx — the global blocklist section on the Compliance page (13a Area 8, 13 §3.7): a
// platform-wide domain block, immediately honored by the suppression gate. A table with an add-domain form and
// a remove action; both need compliance:manage (the controls hide otherwise; the api still enforces it).
// Renders async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  StateSwitch,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { addGlobalSuppression, fetchGlobalSuppression, removeGlobalSuppression } from "../api";
import type { GlobalSuppression as GlobalSuppressionEntry } from "../types";

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function GlobalSuppression() {
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("compliance:manage");

  const [entries, setEntries] = useState<GlobalSuppressionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GlobalSuppressionEntry | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchGlobalSuppression());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the blocklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onAdd() {
    const d = domain.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(d)) {
      toast.error("Enter a bare domain like example.com.");
      return;
    }
    setBusy(true);
    try {
      await addGlobalSuppression(d, reason.trim() || undefined);
      toast.success("Domain blocked globally.");
      setDomain("");
      setReason("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the block");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(entry: GlobalSuppressionEntry) {
    setRemovingId(entry.id);
    try {
      await removeGlobalSuppression(entry.id);
      toast.success("Block removed.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the block");
    } finally {
      setRemovingId(null);
    }
  }

  const columns: Column<GlobalSuppressionEntry>[] = [
    {
      key: "match",
      header: "Match",
      sortValue: (e) => e.domain ?? e.matchType,
      cell: (e) => (
        <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>
          {e.domain ?? `(${e.matchType})`}
        </span>
      ),
    },
    { key: "type", header: "Type", sortValue: (e) => e.matchType, cell: (e) => e.matchType },
    { key: "reason", header: "Reason", cell: (e) => e.reason ?? "—" },
    {
      key: "createdAt",
      header: "Added",
      sortValue: (e) => e.createdAt,
      cell: (e) => <span className="tp-cell-mono">{shortDate(e.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (e) =>
        canManage ? (
          <TpButton
            variant="ghost"
            size="sm"
            disabled={removingId === e.id}
            onClick={() => setRemoveTarget(e)}
          >
            Remove
          </TpButton>
        ) : null,
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Global blocklist</h3>
      <p className="app-muted" style={{ margin: "4px 0 12px", fontSize: 13 }}>
        A blocked domain suppresses reveals and sends for that domain across every tenant.
      </p>

      {canManage ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd();
          }}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: 16,
            maxWidth: 640,
          }}
        >
          <label
            htmlFor="block-domain"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Domain</span>
            <TpInput
              id="block-domain"
              value={domain}
              placeholder="example.com"
              disabled={busy}
              onChange={(e) => setDomain(e.currentTarget.value)}
            />
          </label>
          <label
            htmlFor="block-reason"
            style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 240px" }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (optional)</span>
            <TpInput
              id="block-reason"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <TpButton type="submit" variant="danger" disabled={busy}>
            {busy ? "Blocking…" : "Block domain"}
          </TpButton>
        </form>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!entries && entries.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No global blocks.
          </p>
        }
      >
        <DataTable columns={columns} rows={entries ?? []} rowKey={(e) => e.id} />
      </StateSwitch>

      <Dialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title="Remove global block?"
        description={
          removeTarget
            ? `Unblock "${removeTarget.domain ?? removeTarget.matchType}" across ALL tenants? Reveals and sends to it resume immediately. This is audited.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setRemoveTarget(null)}>
              Cancel
            </TpButton>
            <TpButton
              variant="danger"
              onClick={() => {
                if (removeTarget) void onRemove(removeTarget);
                setRemoveTarget(null);
              }}
            >
              Remove block
            </TpButton>
          </div>
        }
      />
    </div>
  );
}
