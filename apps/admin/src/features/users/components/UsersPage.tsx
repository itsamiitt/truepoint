// UsersPage.tsx — the global (cross-tenant) Users directory (13 §3), read from the api `/admin/users` surface.
// Read-only in this phase (staff mutations come later via audited endpoints). Renders every async state
// through the shared State Kit. Mirrors the Tenants directory structure.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Users } from "lucide-react";
import { statusTone } from "../format";
import { useUsers } from "../hooks/useUsers";
import type { PlatformUser } from "../types";

export function UsersPage() {
  const { users, loading, error, reload } = useUsers();

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

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!users && users.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Users size={20} />}
            title="No users"
            description="No users have been provisioned yet."
          />
        }
      >
        <DataTable columns={columns} rows={users ?? []} rowKey={(u) => u.id} />
      </StateSwitch>
    </div>
  );
}
