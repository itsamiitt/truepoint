// OrganizationPanel.tsx — the Tenant ▸ Organization surface (12 §4): the organization identity form (name /
// logo / default region), the tenant's workspaces (foundation DataTable, create/archive · M2), and a
// members-directory summary (StatTiles + a sample list). Empty-first against the documented-but-unbuilt tenant
// API; no fabricated workspaces, no fake members, and a save that toasts a quiet "not available yet" rather
// than faking persistence. The feature's public component, rendered by the thin (shell)/settings/organization
// route.
"use client";

import {
  Avatar,
  type Column,
  DataTable,
  EmptyState,
  FieldGroup,
  FormSection,
  StatTile,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { Building2, FolderKanban, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useOrganization } from "../hooks/useOrganization";
import {
  MEMBER_STATUS_TONE,
  ORG_ROLE_LABEL,
  type Organization,
  REGIONS,
  type TenantMember,
  type TenantWorkspace,
  WORKSPACE_STATUS_TONE,
} from "../types";
import styles from "../settings-tenant.module.css";

const EMPTY: Organization = { name: "", logoUrl: "", region: "us" };

const workspaceColumns: Column<TenantWorkspace>[] = [
  {
    key: "name",
    header: "Workspace",
    sortValue: (w) => w.name,
    cell: (w) => (
      <span className={styles.wsCell}>
        <span className={styles.wsName}>{w.name}</span>
        <span className={styles.wsSlug}>{w.slug}</span>
      </span>
    ),
  },
  {
    key: "members",
    header: "Members",
    align: "right",
    sortValue: (w) => w.memberCount ?? 0,
    cell: (w) => (w.memberCount != null ? w.memberCount.toLocaleString() : "—"),
  },
  {
    key: "status",
    header: "Status",
    sortValue: (w) => w.status,
    cell: (w) => (
      <StatusBadge tone={WORKSPACE_STATUS_TONE[w.status] as StatusTone}>
        {w.status === "active" ? "Active" : "Archived"}
      </StatusBadge>
    ),
  },
];

export function OrganizationPanel() {
  const toast = useToast();
  const { org, orgAvailable, workspaces, members, error, loading, reload, save } = useOrganization();
  const [form, setForm] = useState<Organization>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (org) setForm({ ...EMPTY, ...org });
  }, [org]);

  const set = (key: keyof Organization, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSave = async () => {
    setSaving(true);
    try {
      const ok = await save(form);
      if (ok) toast.success("Organization updated");
      else
        toast.toast({
          title: "Not available yet",
          description: "Organization settings persist once the tenant API ships.",
        });
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h1 className="tp-settings-title">Organization</h1>

      <StateSwitch loading={loading} error={error} onRetry={reload}>
        <div className={styles.page}>
          {/* ── Identity form ─────────────────────────────────────────────────────────────────── */}
          <FormSection
            title="Identity"
            description="Your organization's name, logo, and where its data lives by default."
          >
            <div className={styles.identityRow}>
              <Avatar name={form.name || "Organization"} size={56} />
              <FieldGroup
                label="Logo URL"
                htmlFor="org-logo"
                hint="Paste an image URL; upload arrives with the tenant API."
                className={styles.identityField}
              >
                <TpInput
                  id="org-logo"
                  value={form.logoUrl ?? ""}
                  onChange={(e) => set("logoUrl", e.target.value)}
                  placeholder="https://…/logo.png"
                />
              </FieldGroup>
            </div>
            <FieldGroup label="Organization name" htmlFor="org-name">
              <TpInput
                id="org-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Acme, Inc."
              />
            </FieldGroup>
            <FieldGroup
              label="Default region"
              htmlFor="org-region"
              hint="New workspaces inherit this data-residency region."
            >
              <TpSelect id="org-region" value={form.region} onChange={(e) => set("region", e.target.value)}>
                {REGIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </TpSelect>
            </FieldGroup>
            <div className={styles.formActions}>
              {!orgAvailable ? (
                <span className={styles.note}>Connect the tenant API to persist changes.</span>
              ) : null}
              <TpButton onClick={onSave} loading={saving}>
                Save changes
              </TpButton>
            </div>
          </FormSection>

          {/* ── Workspaces ────────────────────────────────────────────────────────────────────── */}
          <FormSection
            title="Workspaces"
            description="Every workspace under this organization and its current state."
          >
            <StateSwitch
              empty={workspaces != null && workspaces.workspaces.length === 0}
              emptyState={
                <EmptyState
                  icon={<FolderKanban size={28} />}
                  title={workspaces?.available ? "No workspaces yet" : "Workspaces API not connected"}
                  description={
                    workspaces?.available
                      ? "Workspaces you create will appear here, with limits set by your plan."
                      : "Once the workspaces API ships, your workspaces will appear here."
                  }
                />
              }
            >
              <DataTable
                columns={workspaceColumns}
                rows={workspaces?.workspaces ?? []}
                rowKey={(w) => w.id}
              />
            </StateSwitch>
          </FormSection>

          {/* ── Members directory summary ─────────────────────────────────────────────────────── */}
          <FormSection
            title="Members directory"
            description="A tenant-wide view of who's in your organization. Manage roles in Workspace ▸ Members."
          >
            <StateSwitch
              empty={members != null && members.total === 0}
              emptyState={
                <EmptyState
                  icon={<Users size={28} />}
                  title={members?.available ? "No members yet" : "Members directory not connected"}
                  description={
                    members?.available
                      ? "Invite teammates and they'll show up across the organization."
                      : "Once the tenant members API ships, your directory summary appears here."
                  }
                />
              }
            >
              <div className={styles.summaryTiles}>
                <StatTile
                  label="Total members"
                  value={(members?.total ?? 0).toLocaleString()}
                  sublabel="Across all workspaces"
                />
                <StatTile
                  label="Active"
                  value={(members?.activeCount ?? 0).toLocaleString()}
                  sublabel="Accepted their invite"
                />
                <StatTile
                  label="Invited"
                  value={(members?.invitedCount ?? 0).toLocaleString()}
                  sublabel="Pending acceptance"
                />
              </div>
              {members && members.sample.length > 0 ? (
                <ul className={styles.memberList}>
                  {members.sample.map((m: TenantMember) => (
                    <li key={m.id} className={styles.memberItem}>
                      <Avatar name={m.name || m.email} size={28} />
                      <span className={styles.memberMeta}>
                        <span className={styles.memberName}>{m.name || m.email}</span>
                        {m.name ? <span className={styles.memberEmail}>{m.email}</span> : null}
                      </span>
                      <span className={styles.memberRole}>{ORG_ROLE_LABEL[m.orgRole] ?? m.orgRole}</span>
                      <StatusBadge tone={MEMBER_STATUS_TONE[m.status] as StatusTone}>
                        {m.status === "active"
                          ? "Active"
                          : m.status === "invited"
                            ? "Invited"
                            : "Deactivated"}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </StateSwitch>
          </FormSection>

          <p className={styles.footHint}>
            <Building2 size={13} aria-hidden /> Tenant-level controls (SSO, domains, retention) live under
            Security &amp; access.
          </p>
        </div>
      </StateSwitch>
    </section>
  );
}
