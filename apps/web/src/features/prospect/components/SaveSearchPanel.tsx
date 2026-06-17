// SaveSearchPanel.tsx — the saved-searches block for the prospect rail (24 §8). "Save search" opens a Dialog
// to name the current filter set + choose private/workspace visibility; the list below applies (re-runs the
// search by feeding the persisted ContactQuery back into the rail), and the owner can rename/delete each.
// Composition + view state only — all persistence goes through useSavedSearches; applying is delegated to the
// caller via onApply (which calls useContactSearch's setText/setFilters). Token-styled via @leadwolf/ui.
"use client";

import type { ContactQuery, SavedSearch, SavedSearchVisibility } from "@leadwolf/types";
import {
  Dialog,
  DropdownMenu,
  EmptyState,
  FieldGroup,
  TpButton,
  TpIconButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { Bookmark, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useSavedSearches } from "../hooks/useSavedSearches";

const VISIBILITY_OPTIONS: { value: SavedSearchVisibility; label: string }[] = [
  { value: "private", label: "Only me" },
  { value: "workspace", label: "Everyone in workspace" },
];

export function SaveSearchPanel({
  currentQuery,
  onApply,
}: {
  /** The filter set the rail currently has applied — what "Save search" persists. */
  currentQuery: ContactQuery;
  /** Re-apply a saved search: the caller feeds its filters back into the prospect rail (setText/setFilters). */
  onApply: (filters: ContactQuery) => void;
}) {
  const { searches, loading, error, create, rename, remove } = useSavedSearches();
  const toast = useToast();

  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<SavedSearchVisibility>("private");
  const [saving, setSaving] = useState(false);

  const [renaming, setRenaming] = useState<SavedSearch | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function onSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await create(trimmed, currentQuery, visibility);
      toast.success("Search saved");
      setSaveOpen(false);
      setName("");
      setVisibility("private");
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function onRename() {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await rename(renaming.id, trimmed);
      toast.success("Renamed");
      setRenaming(null);
    } catch (e) {
      toast.error("Could not rename", e instanceof Error ? e.message : undefined);
    }
  }

  async function onDelete(s: SavedSearch) {
    try {
      await remove(s.id);
      toast.success("Deleted");
    } catch (e) {
      toast.error("Could not delete", e instanceof Error ? e.message : undefined);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tp-ink-2)" }}>
          Saved searches
        </span>
        <TpButton variant="secondary" size="sm" onClick={() => setSaveOpen(true)}>
          <Bookmark size={14} aria-hidden /> Save search
        </TpButton>
      </div>

      {error ? (
        <span style={{ fontSize: 12, color: "var(--tp-danger)" }}>{error}</span>
      ) : loading ? (
        <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>Loading…</span>
      ) : searches.length === 0 ? (
        <EmptyState
          title="No saved searches"
          description="Save the current filters to re-run them later."
        />
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {searches.map((s) => (
            <li key={s.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                className="tp-ui-menu-item"
                style={{ flex: 1, textAlign: "left", borderRadius: 8 }}
                onClick={() => onApply(s.filters)}
                title="Apply this search"
              >
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.name}
                </span>
                {s.visibility === "workspace" ? (
                  <span style={{ fontSize: 11, color: "var(--tp-ink-4)" }}>Shared</span>
                ) : null}
              </button>
              {s.isOwner ? (
                <DropdownMenu
                  trigger={({ toggle }) => (
                    <TpIconButton label={`Actions for ${s.name}`} onClick={toggle}>
                      <MoreHorizontal size={16} aria-hidden />
                    </TpIconButton>
                  )}
                  items={[
                    {
                      label: "Rename",
                      onSelect: () => {
                        setRenaming(s);
                        setRenameValue(s.name);
                      },
                    },
                    { label: "Delete", danger: true, onSelect: () => void onDelete(s) },
                  ]}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Save dialog */}
      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save search"
        description="Persist the current filters to re-run them later."
        footer={
          <>
            <TpButton variant="secondary" onClick={() => setSaveOpen(false)} disabled={saving}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onSave()} disabled={saving || name.trim() === ""}>
              {saving ? "Saving…" : "Save"}
            </TpButton>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FieldGroup label="Name" htmlFor="tp-ss-name">
            <TpInput
              id="tp-ss-name"
              value={name}
              autoFocus
              maxLength={120}
              placeholder="e.g. EU fintech decision-makers"
              onChange={(e) => setName(e.target.value)}
            />
          </FieldGroup>
          <FieldGroup label="Visibility" htmlFor="tp-ss-visibility">
            <TpSelect
              id="tp-ss-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as SavedSearchVisibility)}
            >
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </TpSelect>
          </FieldGroup>
        </div>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename search"
        footer={
          <>
            <TpButton variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onRename()} disabled={renameValue.trim() === ""}>
              Save
            </TpButton>
          </>
        }
      >
        <TpInput
          value={renameValue}
          autoFocus
          maxLength={120}
          onChange={(e) => setRenameValue(e.target.value)}
        />
      </Dialog>
    </div>
  );
}
