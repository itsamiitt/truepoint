// StaffPage.tsx — platform STAFF RBAC management (ADR-0011, 13 §11). A DataTable of platform staff (role +
// status) with a grant form and a revoke action behind a confirm dialog. All mutations go to the audited,
// super_admin-gated /admin/staff endpoints; a 403 from the api is surfaced as a clear error (the api is the
// authority — the console never assumes a caller may manage staff). Renders every async state through the
// shared State Kit. Public slice component.
"use client";

import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { grantStaff, revokeStaff } from "../api";
import { useStaff } from "../hooks/useStaff";
import { STAFF_ROLE_OPTIONS, type StaffMember, type StaffRole } from "../types";

const ROLE_LABEL = new Map<string, string>(STAFF_ROLE_OPTIONS.map((o) => [o.value, o.label]));

function statusTone(status: string): StatusTone {
  return status === "active" ? "success" : "muted";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

export function StaffPage() {
  const { staff, loading, error, reload } = useStaff();
  const toast = useToast();

  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<StaffRole>("support");
  const [granting, setGranting] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<StaffMember | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function onGrant() {
    const id = userId.trim();
    if (!id) {
      toast.error("Enter the user id to grant.");
      return;
    }
    setGranting(true);
    try {
      await grantStaff(id, role);
      toast.success("Staff role granted.");
      setUserId("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Grant failed");
    } finally {
      setGranting(false);
    }
  }

  async function onConfirmRevoke() {
    if (!confirmRevoke) return;
    setRevoking(true);
    try {
      await revokeStaff(confirmRevoke.userId);
      toast.success("Staff role revoked.");
      setConfirmRevoke(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setRevoking(false);
    }
  }

  const columns: Column<StaffMember>[] = [
    {
      key: "user",
      header: "User",
      sortValue: (m) => m.email,
      cell: (m) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{m.fullName ?? m.email}</span>
          <span className="tp-cell-mono">{m.email}</span>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      sortValue: (m) => m.staffRole,
      cell: (m) => ROLE_LABEL.get(m.staffRole) ?? m.staffRole,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (m) => m.status,
      cell: (m) => <StatusBadge tone={statusTone(m.status)}>{m.status}</StatusBadge>,
    },
    {
      key: "grantedAt",
      header: "Granted",
      sortValue: (m) => m.grantedAt,
      cell: (m) => <span className="tp-cell-mono">{shortDate(m.grantedAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (m) =>
        m.status === "active" ? (
          <TpButton variant="ghost" size="sm" onClick={() => setConfirmRevoke(m)}>
            Revoke
          </TpButton>
        ) : null,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Staff</h2>
          <p className="tp-page-sub">
            Platform staff roles — who can operate TruePoint across tenants, and at what role.
            Grants and revokes are audited.
          </p>
        </div>
      </div>

      {/* Grant form — userId is a server-resolved identity; the api re-validates it as a UUID and audits. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <label
          htmlFor="staff-grant-user"
          style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 280px" }}
        >
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>User id</span>
          <TpInput
            id="staff-grant-user"
            value={userId}
            placeholder="user UUID"
            disabled={granting}
            onChange={(e) => setUserId(e.currentTarget.value)}
          />
        </label>
        <label
          htmlFor="staff-grant-role"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Role</span>
          <TpSelect
            id="staff-grant-role"
            value={role}
            disabled={granting}
            onChange={(e) => setRole(e.currentTarget.value as StaffRole)}
          >
            {STAFF_ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </TpSelect>
        </label>
        <TpButton onClick={() => void onGrant()} disabled={granting}>
          {granting ? "Granting…" : "Grant role"}
        </TpButton>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!staff && staff.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No staff"
            description="No platform staff have been granted yet."
          />
        }
      >
        <DataTable columns={columns} rows={staff ?? []} rowKey={(m) => m.userId} />
      </StateSwitch>

      <Dialog
        open={!!confirmRevoke}
        onClose={() => (revoking ? undefined : setConfirmRevoke(null))}
        title="Revoke staff role"
        description={
          confirmRevoke
            ? `Revoke ${ROLE_LABEL.get(confirmRevoke.staffRole) ?? confirmRevoke.staffRole} from ${confirmRevoke.email}? They lose all platform-staff access on their next request.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton
              variant="secondary"
              onClick={() => setConfirmRevoke(null)}
              disabled={revoking}
            >
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={() => void onConfirmRevoke()} disabled={revoking}>
              {revoking ? "Revoking…" : "Revoke"}
            </TpButton>
          </div>
        }
      />
    </div>
  );
}
