// UsersPage.tsx — the global (cross-tenant) Users directory (13 §3.2), read from the api `/admin/users`
// surface, with a per-row deactivate / reactivate action behind a reason dialog (13a Area 2). All mutations go
// to the audited, super_admin|support-gated endpoints; a 403/422 from the api (e.g. a protected staff target
// or self-deactivation) is surfaced as a clear toast. Renders every async state through the shared State Kit.
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
  TpSelect,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { Search, Users } from "lucide-react";
import { useState } from "react";
import { deactivateUser, reactivateUser } from "../api";
import { statusTone } from "../format";
import { useUsers } from "../hooks/useUsers";
import type { PlatformUser } from "../types";

const MIN_REASON = 5;
type PendingAction = { user: PlatformUser; kind: "deactivate" | "reactivate" };

export function UsersPage() {
  const {
    users,
    nextCursor,
    status,
    loading,
    loadingMore,
    error,
    applySearch,
    applyStatus,
    loadMore,
    reload,
  } = useUsers();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("users:deactivate");

  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  function openAction(action: PendingAction) {
    setReason("");
    setPending(action);
  }

  async function onConfirm() {
    if (!pending) return;
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      if (pending.kind === "deactivate") await deactivateUser(pending.user.id, r);
      else await reactivateUser(pending.user.id, r);
      toast.success(pending.kind === "deactivate" ? "User deactivated." : "User reactivated.");
      setPending(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<PlatformUser>[] = [
    {
      key: "email",
      header: "Email",
      sortValue: (u) => u.email,
      cell: (u) => <span className="tp-cell-mono">{u.email}</span>,
    },
    {
      key: "fullName",
      header: "Name",
      sortValue: (u) => u.fullName ?? "",
      cell: (u) => u.fullName ?? "—",
    },
    {
      key: "status",
      header: "Status",
      sortValue: (u) => u.status,
      cell: (u) => <StatusBadge tone={statusTone(u.status)}>{u.status}</StatusBadge>,
    },
    {
      key: "platformAdmin",
      header: "Platform admin",
      sortValue: (u) => (u.isPlatformAdmin ? 1 : 0),
      cell: (u) =>
        u.isPlatformAdmin ? <StatusBadge tone="warning">Staff</StatusBadge> : <span>—</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      // Suspended → reactivate. Active & non-staff → deactivate. Active staff accounts are protected here
      // (the api refuses to deactivate them); reactivating a suspended account is always offered. The action is
      // hidden entirely when the caller's role lacks users:deactivate (the api still enforces it).
      cell: (u) =>
        !canManage ? (
          <span className="app-muted">—</span>
        ) : u.status === "suspended" ? (
          <TpButton
            variant="ghost"
            size="sm"
            onClick={() => openAction({ user: u, kind: "reactivate" })}
          >
            Reactivate
          </TpButton>
        ) : u.isPlatformAdmin ? (
          <span className="app-muted">—</span>
        ) : (
          <TpButton
            variant="ghost"
            size="sm"
            onClick={() => openAction({ user: u, kind: "deactivate" })}
          >
            Deactivate
          </TpButton>
        ),
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Users</h2>
          <p className="tp-page-sub">
            Cross-tenant user directory — status and platform-admin grants across all orgs.
          </p>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {/* Server-side search over email / name; Enter or the button applies it (keeps the status filter). */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applySearch(query.trim());
          }}
          style={{ display: "flex", gap: 8, maxWidth: 420, flex: "1 1 320px" }}
        >
          <TpInput
            value={query}
            placeholder="Search by email or name…"
            aria-label="Search users"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <TpButton type="submit" variant="secondary">
            <Search size={14} /> Search
          </TpButton>
        </form>
        <TpSelect
          aria-label="Status filter"
          value={status}
          onChange={(e) => applyStatus(e.currentTarget.value)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </TpSelect>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!users && users.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Users size={20} />}
            title="No users"
            description="No users match the current search."
          />
        }
      >
        <DataTable columns={columns} rows={users ?? []} rowKey={(u) => u.id} />
        {nextCursor ? (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
            <TpButton variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>

      <Dialog
        open={!!pending}
        onClose={() => (busy ? undefined : setPending(null))}
        title={pending?.kind === "deactivate" ? "Deactivate user" : "Reactivate user"}
        description={
          pending
            ? pending.kind === "deactivate"
              ? `Deactivate ${pending.user.email}. They lose access across all orgs until reactivated. This is audited.`
              : `Restore access for ${pending.user.email}. This is audited.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant={pending?.kind === "deactivate" ? "danger" : "primary"}
              onClick={() => void onConfirm()}
              disabled={busy}
            >
              {busy ? "Working…" : pending?.kind === "deactivate" ? "Deactivate" : "Reactivate"}
            </TpButton>
          </div>
        }
      >
        <label
          htmlFor="user-action-reason"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
          <TpTextarea
            id="user-action-reason"
            value={reason}
            rows={3}
            placeholder="Why is this account being deactivated / reactivated?"
            disabled={busy}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
