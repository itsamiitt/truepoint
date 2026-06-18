// TagPicker.tsx — assign/unassign tags on a record from the RecordDetail panel (ADR-0028, G-REV-6). Loads
// the workspace tags on open via the foundation Popover, toggles assignment with an optimistic update, and
// supports MINIMAL inline create (name + a palette-key color swatch). Its own component; the assignment/
// uniqueness/RLS rules all live server-side — this is composition + view state. Tag colors come from the
// brand palette KEY (tagColors.ts), never a raw hex.
"use client";

import type { TagColor, TaggableEntity } from "@leadwolf/types";
import { Popover, Spinner, TpButton, TpInput, useToast } from "@leadwolf/ui";
import { Plus, Tag as TagIcon } from "lucide-react";
import { useState } from "react";
import { ApiError, type RecordTag, assignTag, createTag, fetchTags, unassignTag } from "../api";
import { TAG_COLOR_OPTIONS, tagColorVar } from "../tagColors";
import { TagChip } from "./TagChip";

/** The minimal tag shape the picker manipulates (chip + assignment). Both the full Tag and RecordTag fit. */
type PickerTag = RecordTag;

export function TagPicker({
  recordId,
  entity = "contact",
  assigned,
  onChange,
  onTagCreated,
}: {
  recordId: string;
  entity?: TaggableEntity;
  /** The tags currently assigned to this record (owned by the parent so chips re-render on change). */
  assigned: PickerTag[];
  /** Apply the next assigned-tag list. A functional updater (prev → next) so concurrent assign/unassign/
   *  create mutations compose instead of clobbering each other (each reads the latest committed state). */
  onChange: (updater: (prev: PickerTag[]) => PickerTag[]) => void;
  /** Called after a NEW workspace tag is created, so callers can refresh a workspace-wide tag list. */
  onTagCreated?: () => void;
}) {
  const toast = useToast();
  const [all, setAll] = useState<PickerTag[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState<TagColor>("neutral");
  const [creating, setCreating] = useState(false);

  const assignedIds = new Set(assigned.map((t) => t.id));

  /** Insert a tag into a list keeping it name-sorted + de-duplicated by id (idempotent). */
  const withTag = (list: PickerTag[], tag: PickerTag): PickerTag[] =>
    list.some((t) => t.id === tag.id)
      ? list
      : [...list, tag].sort((a, b) => a.name.localeCompare(b.name));

  const load = async () => {
    setLoading(true);
    try {
      setAll(await fetchTags());
    } catch (e) {
      toast.error("Could not load tags", e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (tag: PickerTag) => {
    if (busyId === tag.id) return; // guard same-tag double-fire from any entry point (chip × or option)
    const isOn = assignedIds.has(tag.id);
    setBusyId(tag.id);
    try {
      if (isOn) {
        await unassignTag(tag.id, entity, recordId);
        onChange((prev) => prev.filter((t) => t.id !== tag.id));
      } else {
        await assignTag(tag.id, entity, recordId);
        onChange((prev) => withTag(prev, tag));
      }
    } catch (e) {
      toast.error("Could not update tag", e instanceof Error ? e.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const name = draftName.trim();
    if (creating || !name) return;
    setCreating(true);
    try {
      const { id } = await createTag(name, draftColor);
      const tag: PickerTag = { id, name, color: draftColor };
      await assignTag(id, entity, recordId);
      setAll((cur) => withTag(cur ?? [], tag));
      onChange((prev) => withTag(prev, tag));
      onTagCreated?.();
      setDraftName("");
      setDraftColor("neutral");
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === "tag_name_taken"
          ? "A tag with that name already exists."
          : e instanceof Error
            ? e.message
            : undefined;
      toast.error("Could not create tag", msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {assigned.map((t) => (
        <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => toggle(t)} />
      ))}

      <Popover
        align="start"
        trigger={({ toggle: toggleOpen, open }) => (
          <TpButton
            variant="ghost"
            size="sm"
            leftIcon={<TagIcon size={14} />}
            aria-expanded={open}
            onClick={() => {
              if (!open && all === null) void load();
              toggleOpen();
            }}
          >
            {assigned.length === 0 ? "Add tag" : "Edit"}
          </TpButton>
        )}
      >
        <div
          style={{ minWidth: 220, display: "flex", flexDirection: "column", gap: 8, padding: 4 }}
        >
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 8 }}>
              <Spinner />
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(all ?? []).map((t) => (
                <TagChip
                  key={t.id}
                  name={t.name}
                  color={t.color}
                  active={assignedIds.has(t.id)}
                  onClick={() => {
                    if (busyId !== t.id) void toggle(t);
                  }}
                />
              ))}
              {all !== null && all.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>No tags yet.</span>
              ) : null}
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--tp-hairline-2)", paddingTop: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <TpInput
                placeholder="New tag…"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
              <TpButton
                variant="primary"
                size="sm"
                leftIcon={<Plus size={14} />}
                disabled={creating || draftName.trim() === ""}
                onClick={() => void create()}
              >
                Add
              </TpButton>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              {TAG_COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={draftColor === c}
                  onClick={() => setDraftColor(c)}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: tagColorVar(c),
                    border:
                      draftColor === c
                        ? "2px solid var(--tp-ink)"
                        : "2px solid var(--tp-hairline-2)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </Popover>
    </div>
  );
}
