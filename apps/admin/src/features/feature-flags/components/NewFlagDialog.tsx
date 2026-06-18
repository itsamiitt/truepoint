// NewFlagDialog.tsx — define a new (or upsert an existing) feature flag (13 §3.5). A small form dialog
// (key · description · default) that POSTs the audited upsert; rendered by FeatureFlagsPage.
"use client";

import {
  Dialog,
  FieldGroup,
  FormSection,
  TpButton,
  TpInput,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { useState } from "react";
import { upsertFeatureFlag } from "../api";

export function NewFlagDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await upsertFeatureFlag({
        key: key.trim(),
        description: description.trim() || undefined,
        default: defaultEnabled,
      });
      toast.success(`Flag ${key.trim()} saved`);
      setKey("");
      setDescription("");
      setDefaultEnabled(false);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New feature flag"
      maxWidth={460}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <TpButton variant="secondary" onClick={onClose}>
            Cancel
          </TpButton>
          <TpButton loading={saving} disabled={key.trim().length < 2} onClick={() => void save()}>
            Save flag
          </TpButton>
        </div>
      }
    >
      <FormSection>
        <FieldGroup
          label="Key"
          htmlFor="ff-key"
          hint="Lowercase dotted/underscored, e.g. bulk_enrich"
        >
          <TpInput
            id="ff-key"
            value={key}
            placeholder="bulk_enrich"
            onChange={(e) => setKey(e.currentTarget.value)}
          />
        </FieldGroup>
        <FieldGroup label="Description" htmlFor="ff-desc">
          <TpInput
            id="ff-desc"
            value={description}
            placeholder="What this flag gates"
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </FieldGroup>
        <FieldGroup label="Default when no global/override decides" htmlFor="ff-default">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <TpSwitch
              id="ff-default"
              checked={defaultEnabled}
              onChange={(e) => setDefaultEnabled(e.currentTarget.checked)}
            />
            <span style={{ fontSize: 13 }}>{defaultEnabled ? "On" : "Off"}</span>
          </span>
        </FieldGroup>
      </FormSection>
    </Dialog>
  );
}
