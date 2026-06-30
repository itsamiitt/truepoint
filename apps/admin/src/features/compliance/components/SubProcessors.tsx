// SubProcessors.tsx — the GDPR Art. 28 sub-processor registry section on the Compliance page (13a Area 8): the
// third parties that process customer/prospect data on TruePoint's behalf (name · purpose · processing location ·
// DPA link). A table with create / edit and remove / restore, all going to the audited, compliance:manage-gated
// api. The create/edit/toggle controls hide without the capability (the api still enforces it). Renders via the
// State Kit. Mirrors RetentionPolicies (the sibling Area-8 config section).
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import {
  createSubProcessor,
  fetchSubProcessors,
  setSubProcessorActive,
  updateSubProcessor,
} from "../api";
import type { SubProcessor } from "../types";

interface Draft {
  id: string | null;
  name: string;
  purpose: string;
  location: string;
  dpaUrl: string;
  sortOrder: string;
}

const EMPTY: Draft = { id: null, name: "", purpose: "", location: "", dpaUrl: "", sortOrder: "0" };

export function SubProcessors() {
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("compliance:manage");

  const [rows, setRows] = useState<SubProcessor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchSubProcessors());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sub-processors");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openNew() {
    setDraft({ ...EMPTY });
  }
  function openEdit(p: SubProcessor) {
    setDraft({
      id: p.id,
      name: p.name,
      purpose: p.purpose,
      location: p.location,
      dpaUrl: p.dpaUrl ?? "",
      sortOrder: String(p.sortOrder),
    });
  }

  async function onSave() {
    if (!draft) return;
    const name = draft.name.trim();
    const purpose = draft.purpose.trim();
    const location = draft.location.trim();
    if (!name || !purpose || !location) {
      toast.error("Name, purpose and location are required.");
      return;
    }
    const dpaUrl = draft.dpaUrl.trim();
    if (dpaUrl && !/^https?:\/\/\S+$/.test(dpaUrl)) {
      toast.error("The DPA link must be an http(s) URL (or left blank).");
      return;
    }
    const sortOrder = Number(draft.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
      toast.error("Sort order must be a whole number between 0 and 100000.");
      return;
    }
    const input = { name, purpose, location, dpaUrl: dpaUrl || undefined, sortOrder };
    setBusy(true);
    try {
      if (draft.id) await updateSubProcessor(draft.id, input);
      else await createSubProcessor(input);
      toast.success(draft.id ? "Sub-processor updated." : "Sub-processor added.");
      setDraft(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the sub-processor");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(p: SubProcessor) {
    setTogglingId(p.id);
    try {
      await setSubProcessorActive(p.id, !p.active);
      toast.success(p.active ? "Sub-processor removed." : "Sub-processor restored.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the sub-processor");
    } finally {
      setTogglingId(null);
    }
  }

  const columns: Column<SubProcessor>[] = [
    {
      key: "name",
      header: "Sub-processor",
      sortValue: (p) => p.sortOrder,
      cell: (p) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{p.name}</span>
          <span className="app-muted" style={{ fontSize: 12 }}>
            {p.location}
          </span>
        </div>
      ),
    },
    {
      key: "purpose",
      header: "Purpose",
      cell: (p) => p.purpose,
    },
    {
      key: "dpa",
      header: "DPA",
      cell: (p) =>
        p.dpaUrl ? (
          <a href={p.dpaUrl} target="_blank" rel="noreferrer noopener" className="tp-link">
            link
          </a>
        ) : (
          <span className="app-muted">—</span>
        ),
    },
    {
      key: "active",
      header: "Status",
      sortValue: (p) => (p.active ? 0 : 1),
      cell: (p) => (
        <StatusBadge tone={p.active ? "success" : "muted"}>
          {p.active ? "Published" : "Removed"}
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
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === p.id}
              onClick={() => openEdit(p)}
            >
              Edit
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === p.id}
              onClick={() => void onToggle(p)}
            >
              {p.active ? "Remove" : "Restore"}
            </TpButton>
          </div>
        ) : (
          <span className="app-muted">—</span>
        ),
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <h3 className="tp-section-title">Sub-processors</h3>
        {canManage ? <TpButton onClick={openNew}>New sub-processor</TpButton> : null}
      </div>
      <p className="app-muted" style={{ margin: "4px 0 12px", fontSize: 13 }}>
        The third parties that process data on TruePoint's behalf (GDPR Art. 28). A removed entry is
        kept for the disclosure history.
      </p>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!rows && rows.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No sub-processors recorded.
          </p>
        }
      >
        <DataTable columns={columns} rows={rows ?? []} rowKey={(p) => p.id} />
      </StateSwitch>

      <Dialog
        open={!!draft}
        onClose={() => (busy ? undefined : setDraft(null))}
        title={draft?.id ? "Edit sub-processor" : "New sub-processor"}
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
            <label htmlFor="sp-name" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Name</span>
              <TpInput
                id="sp-name"
                value={draft.name}
                placeholder="e.g. Amazon Web Services"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </label>
            <label
              htmlFor="sp-purpose"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Purpose</span>
              <TpInput
                id="sp-purpose"
                value={draft.purpose}
                placeholder="e.g. Cloud hosting & storage"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, purpose: e.currentTarget.value })}
              />
            </label>
            <label
              htmlFor="sp-location"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Processing location</span>
              <TpInput
                id="sp-location"
                value={draft.location}
                placeholder="e.g. EU (Ireland)"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, location: e.currentTarget.value })}
              />
            </label>
            <label htmlFor="sp-dpa" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>DPA link (optional)</span>
              <TpInput
                id="sp-dpa"
                type="url"
                value={draft.dpaUrl}
                placeholder="https://…"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, dpaUrl: e.currentTarget.value })}
              />
            </label>
            <label htmlFor="sp-sort" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Sort order</span>
              <TpInput
                id="sp-sort"
                type="number"
                min={0}
                value={draft.sortOrder}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, sortOrder: e.currentTarget.value })}
              />
            </label>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
