// ContentPage.tsx — the announcements authoring surface (13a Area 10, 13 §3.10): staff publish in-app banners
// customers see. A table with create / edit and show / retire toggles, all going to the audited,
// content:manage-gated api. Renders async state through the State Kit.
"use client";

import { TenantPicker } from "@/components/TenantPicker";
import { useStaffMe } from "@/lib/staffMe";
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
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { Megaphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { createAnnouncement, setAnnouncementActive, updateAnnouncement } from "../api";
import { useContent } from "../hooks/useContent";
import type { Announcement } from "../types";

const LEVELS = ["info", "warning", "critical"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Draft {
  id: string | null; // null = creating
  title: string;
  body: string;
  level: string;
  audience: string; // all | tenant
  tenantTarget: string;
  tenantTargetName: string | null; // display name of the picked tenant when known (UX only)
  startsDate: string;
  endsDate: string;
}

const EMPTY: Draft = {
  id: null,
  title: "",
  body: "",
  level: "info",
  audience: "all",
  tenantTarget: "",
  tenantTargetName: null,
  startsDate: "",
  endsDate: "",
};

function levelTone(level: string): StatusTone {
  if (level === "critical") return "danger";
  if (level === "warning") return "warning";
  return "muted";
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export function ContentPage() {
  const { announcements, loading, error, reload } = useContent();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("content:manage");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  function openNew() {
    setDraft({ ...EMPTY });
  }
  function openEdit(a: Announcement) {
    setDraft({
      id: a.id,
      title: a.title,
      body: a.body,
      level: a.level,
      audience: a.audience,
      tenantTarget: a.tenantTarget ?? "",
      tenantTargetName: null,
      startsDate: a.startsAt ? a.startsAt.slice(0, 10) : "",
      endsDate: a.endsAt ? a.endsAt.slice(0, 10) : "",
    });
  }

  async function onSave() {
    if (!draft) return;
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title || !body) {
      toast.error("Enter a title and body.");
      return;
    }
    const tenantTarget = draft.audience === "tenant" ? draft.tenantTarget.trim() : null;
    if (draft.audience === "tenant" && (!tenantTarget || !UUID_RE.test(tenantTarget))) {
      toast.error("A tenant-targeted announcement needs a valid tenant UUID.");
      return;
    }
    // yyyy-mm-dd strings sort chronologically, so a lexical compare guards an inverted display window.
    if (draft.startsDate && draft.endsDate && draft.startsDate > draft.endsDate) {
      toast.error("The start date must be on or before the end date.");
      return;
    }
    const input = {
      title,
      body,
      level: draft.level,
      audience: draft.audience,
      tenantTarget,
      startsAt: draft.startsDate ? `${draft.startsDate}T00:00:00.000Z` : null,
      endsAt: draft.endsDate ? `${draft.endsDate}T23:59:59.999Z` : null,
    };
    setBusy(true);
    try {
      if (draft.id) await updateAnnouncement(draft.id, input);
      else await createAnnouncement(input);
      toast.success(draft.id ? "Announcement updated." : "Announcement published.");
      setDraft(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the announcement");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(a: Announcement) {
    setTogglingId(a.id);
    try {
      await setAnnouncementActive(a.id, !a.active);
      toast.success(a.active ? "Announcement retired." : "Announcement shown.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the announcement");
    } finally {
      setTogglingId(null);
    }
  }

  const columns: Column<Announcement>[] = [
    {
      key: "title",
      header: "Announcement",
      sortValue: (a) => a.title,
      cell: (a) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{a.title}</span>
          <span className="app-muted" style={{ fontSize: 12 }}>
            {a.audience === "tenant"
              ? `tenant ${(a.tenantTarget ?? "").slice(0, 8)}`
              : "all tenants"}
          </span>
        </div>
      ),
    },
    {
      key: "level",
      header: "Level",
      sortValue: (a) => a.level,
      cell: (a) => <StatusBadge tone={levelTone(a.level)}>{a.level}</StatusBadge>,
    },
    {
      key: "window",
      header: "Window",
      cell: (a) => (
        <span className="tp-cell-mono">
          {shortDate(a.startsAt)} → {shortDate(a.endsAt)}
        </span>
      ),
    },
    {
      key: "active",
      header: "Status",
      sortValue: (a) => (a.active ? 0 : 1),
      cell: (a) => (
        <StatusBadge tone={a.active ? "success" : "muted"}>
          {a.active ? "Shown" : "Retired"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (a) =>
        canManage ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === a.id}
              onClick={() => openEdit(a)}
            >
              Edit
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === a.id}
              onClick={() => void onToggle(a)}
            >
              {a.active ? "Retire" : "Show"}
            </TpButton>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Content</h2>
          <p className="tp-page-sub">
            In-app announcements / banners shown to customers — to all tenants or a targeted org.
          </p>
        </div>
        {canManage ? <TpButton onClick={openNew}>New announcement</TpButton> : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!announcements && announcements.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Megaphone size={20} />}
            title="No announcements"
            description="Publish the first in-app announcement."
          />
        }
      >
        <DataTable columns={columns} rows={announcements ?? []} rowKey={(a) => a.id} />
      </StateSwitch>

      <Dialog
        open={!!draft}
        onClose={() => (busy ? undefined : setDraft(null))}
        title={draft?.id ? "Edit announcement" : "New announcement"}
        maxWidth={560}
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
            <Field label="Title" htmlFor="a-title">
              <TpInput
                id="a-title"
                value={draft.title}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })}
              />
            </Field>
            <Field label="Body" htmlFor="a-body">
              <TpTextarea
                id="a-body"
                value={draft.body}
                rows={3}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, body: e.currentTarget.value })}
              />
            </Field>
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Level" htmlFor="a-level" grow>
                <TpSelect
                  id="a-level"
                  value={draft.level}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, level: e.currentTarget.value })}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </TpSelect>
              </Field>
              <Field label="Audience" htmlFor="a-audience" grow>
                <TpSelect
                  id="a-audience"
                  value={draft.audience}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, audience: e.currentTarget.value })}
                >
                  <option value="all">All tenants</option>
                  <option value="tenant">One tenant</option>
                </TpSelect>
              </Field>
            </div>
            {draft.audience === "tenant" ? (
              <Field label="Target tenant" htmlFor="a-target">
                <TenantPicker
                  id="a-target"
                  value={draft.tenantTarget}
                  selectedName={draft.tenantTargetName}
                  disabled={busy}
                  onChange={(id, name) =>
                    setDraft({ ...draft, tenantTarget: id, tenantTargetName: name })
                  }
                />
              </Field>
            ) : null}
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Start (optional)" htmlFor="a-start" grow>
                <TpInput
                  id="a-start"
                  type="date"
                  value={draft.startsDate}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, startsDate: e.currentTarget.value })}
                />
              </Field>
              <Field label="End (optional)" htmlFor="a-end" grow>
                <TpInput
                  id="a-end"
                  type="date"
                  value={draft.endsDate}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, endsDate: e.currentTarget.value })}
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
