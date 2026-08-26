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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GlobalSuppressionEntry | null>(null);

  // First page for the current search (PA-12): the list is keyset-paged now, so "is example.com blocked?"
  // is answered by SEARCHING, not by hoping it is in the newest page.
  const reload = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchGlobalSuppression({ q: q || undefined });
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the blocklist");
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search → first page. 300ms keeps a typing staff member from firing a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void reload(search.trim()), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchGlobalSuppression({
        q: search.trim() || undefined,
        cursor: nextCursor,
      });
      setEntries((prev) => [...(prev ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, search]);

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
      await reload(search.trim());
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
      await reload(search.trim());
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
      <p
        className="app-muted"
        style={{ margin: "var(--tp-space-1) 0 var(--tp-space-3)", fontSize: "var(--tp-text-body)" }}
      >
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
            gap: "var(--tp-space-2)",
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: "var(--tp-space-4)",
            maxWidth: 640,
          }}
        >
          <label
            htmlFor="block-domain"
            style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-1)" }}
          >
            <span style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
              Domain
            </span>
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
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--tp-space-1)",
              flex: "1 1 240px",
            }}
          >
            <span style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
              Reason (optional)
            </span>
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

      <div style={{ marginBottom: "var(--tp-space-3)", maxWidth: 320 }}>
        <label
          htmlFor="block-search"
          style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-1)" }}
        >
          <span style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
            Search blocked domains
          </span>
          <TpInput
            id="block-search"
            value={search}
            placeholder="example.com"
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!entries && entries.length === 0}
        onRetry={() => void reload(search.trim())}
        emptyState={
          <p className="app-muted" style={{ padding: "var(--tp-space-4)" }}>
            {search.trim() ? "No blocks match this search." : "No global blocks."}
          </p>
        }
      >
        <DataTable columns={columns} rows={entries ?? []} rowKey={(e) => e.id} />
        {nextCursor ? (
          <div style={{ marginTop: "var(--tp-space-3)" }}>
            <TpButton variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </TpButton>
          </div>
        ) : null}
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
          <div style={{ display: "flex", gap: "var(--tp-space-2)", justifyContent: "flex-end" }}>
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
