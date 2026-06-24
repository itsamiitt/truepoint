// ListFormDialog.tsx — the create / rename dialog for a list. One dialog, two modes: `list === null` creates a
// new (empty) list; a non-null `list` renames/re-describes it (the API enforces owner-only on rename — a
// non-owned id 404s, surfaced as a toast). Name is bounded to 120 chars (the DB column + the Zod schema agree).
// Composition only — the create/update calls live in the lists api client; the parent reloads on success.
"use client";

import type { List } from "@leadwolf/types";
import { Dialog, FieldGroup, TpButton, TpInput, TpTextarea, useToast } from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { createList, updateList } from "../api";
import styles from "../lists.module.css";

export function ListFormDialog({
  open,
  list,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null → create mode; a list → rename/edit mode. */
  list: List | null;
  onClose: () => void;
  /** Fired with the created/updated list after a successful save (the parent reloads + may navigate). */
  onSaved?: (saved: List) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // Seed the fields from the list each time the dialog opens (or clear them in create mode).
  useEffect(() => {
    if (open) {
      setName(list?.name ?? "");
      setDescription(list?.description ?? "");
    }
  }, [open, list]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= 120 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const desc = description.trim();
      const saved = list
        ? await updateList(list.id, { name: trimmed, description: desc === "" ? null : desc })
        : await createList(trimmed, desc === "" ? undefined : desc);
      toast.success(list ? "List updated" : "List created");
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error(
        list ? "Could not update list" : "Could not create list",
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={list ? "Rename list" : "New list"}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Saving…" : list ? "Save" : "Create"}
          </TpButton>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <FieldGroup label="Name" htmlFor="tp-list-name">
          <TpInput
            id="tp-list-name"
            value={name}
            maxLength={120}
            placeholder="e.g. Q3 priority outreach"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </FieldGroup>
        <FieldGroup label="Description (optional)" htmlFor="tp-list-desc">
          <TpTextarea
            id="tp-list-desc"
            value={description}
            maxLength={500}
            rows={3}
            placeholder="What this list is for"
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FieldGroup>
      </div>
    </Dialog>
  );
}
