// MembersPanel.tsx — Workspace ▸ Members & roles: an invite row + a members DataTable with inline role changes
// and a remove confirmation Dialog. Empty-first against the unbuilt members API; no fabricated members, and
// every mutation that isn't wired yet surfaces a quiet "not available" toast.
"use client";

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
  useToast,
} from "@leadwolf/ui";
import { Users } from "lucide-react";
import { useState } from "react";
import { useMembers } from "../hooks/useMembers";
import { ASSIGNABLE_ROLES, ROLE_LABEL, type WorkspaceMember, type WorkspaceRole } from "../types";
import styles from "../settings-workspace.module.css";

export function MembersPanel() {
  const toast = useToast();
  const { feed, loading, error, reload, invite, changeRole, remove } = useMembers();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [inviting, setInviting] = useState(false);
  const [toRemove, setToRemove] = useState<WorkspaceMember | null>(null);

  const notWired = () =>
    toast.toast({ title: "Not available yet", description: "Member management connects once the API ships." });

  const onInvite = async () => {
    if (email.trim().length === 0) return;
    setInviting(true);
    try {
      const ok = await invite(email.trim(), role);
      if (ok) {
        toast.success("Invite sent");
        setEmail("");
      } else notWired();
    } catch (e) {
      toast.error("Could not invite", e instanceof Error ? e.message : undefined);
    } finally {
      setInviting(false);
    }
  };

  const onRole = async (member: WorkspaceMember, next: WorkspaceRole) => {
    const ok = await changeRole(member.id, next);
    if (ok) toast.success("Role updated");
    else notWired();
  };

  const onRemove = async () => {
    if (!toRemove) return;
    const ok = await remove(toRemove.id);
    if (ok) toast.success("Member removed");
    else notWired();
    setToRemove(null);
  };

  const columns: Column<WorkspaceMember>[] = [
    {
      key: "member",
      header: "Member",
      sortValue: (m) => m.email,
      cell: (m) => (
        <span className={styles.memberCell}>
          <span className={styles.memberEmail}>{m.email}</span>
          {m.name ? <span className={styles.memberName}>{m.name}</span> : null}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (m) =>
        m.role === "owner" ? (
          <StatusBadge tone="muted">Owner</StatusBadge>
        ) : (
          <TpSelect
            className={styles.roleSelect}
            value={m.role}
            onChange={(e) => onRole(m, e.target.value as WorkspaceRole)}
            aria-label={`Role for ${m.email}`}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </TpSelect>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => (
        <StatusBadge tone={m.status === "active" ? "success" : "warning"}>
          {m.status === "active" ? "Active" : "Invited"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (m) =>
        m.role === "owner" ? null : (
          <TpButton variant="ghost" size="sm" onClick={() => setToRemove(m)}>
            Remove
          </TpButton>
        ),
    },
  ];

  return (
    <section>
      <h1 className="tp-settings-title">Members</h1>
      <div className={styles.inviteRow}>
        <TpInput
          className={styles.inviteEmail}
          type="email"
          placeholder="teammate@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TpSelect
          className={styles.inviteRole}
          value={role}
          onChange={(e) => setRole(e.target.value as WorkspaceRole)}
          aria-label="Invite role"
        >
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </TpSelect>
        <TpButton onClick={onInvite} loading={inviting} disabled={email.trim().length === 0}>
          Invite
        </TpButton>
      </div>
      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.members.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<Users size={28} />}
            title={feed?.available ? "Just you so far" : "Members API not connected"}
            description={
              feed?.available
                ? "Invite teammates to collaborate in this workspace."
                : "Once the members API ships, your team will appear here."
            }
          />
        }
      >
        <DataTable columns={columns} rows={feed?.members ?? []} rowKey={(m) => m.id} />
      </StateSwitch>
      <Dialog
        open={toRemove != null}
        onClose={() => setToRemove(null)}
        title="Remove member?"
        description={
          toRemove ? `${toRemove.email} will lose access to this workspace.` : undefined
        }
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToRemove(null)}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onRemove}>
              Remove
            </TpButton>
          </>
        }
      />
    </section>
  );
}
