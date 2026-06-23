// CustomFieldsPanel.tsx — Workspace ▸ Custom fields settings (ADR-0028, gap G-REV-5). Lists the workspace's
// field definitions per entity (contact/account), and a Dialog to add one or archive/restore an existing one.
// Dirty form state is local; saves go through the documented contract — a not-built backend (404/501) toasts a
// quiet "not available yet" (no fake persistence). All UI uses the @leadwolf/ui kit + --tp-* tokens.
"use client";

import type { CustomFieldDefinitionDto } from "@leadwolf/types";
import {
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  FormSection,
  SegmentedControl,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  TpSwitch,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useCustomFieldDefinitions } from "../hooks/useCustomFieldDefinitions";
import styles from "../settings-custom-fields.module.css";
import { type CustomFieldForm, EMPTY_FORM, FIELD_TYPE_OPTIONS } from "../types";

const ENTITY_TABS = [
  { value: "contact", label: "Contacts" },
  { value: "account", label: "Accounts" },
] as const;

export function CustomFieldsPanel() {
  const toast = useToast();
  const [entity, setEntity] = useState<"contact" | "account">("contact");
  const { definitions, available, error, loading, reload, create, update } =
    useCustomFieldDefinitions(entity);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CustomFieldForm>(EMPTY_FORM);
  const [optionsText, setOptionsText] = useState("");
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof CustomFieldForm>(key: K, value: CustomFieldForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Mirror the server's create rule client-side: key + label always, plus ≥1 option for a select field.
  const hasOptions = optionsText.split("\n").some((s) => s.trim().length > 0);
  const canSave =
    form.key.length > 0 && form.label.length > 0 && (form.fieldType !== "select" || hasOptions);

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, entity });
    setOptionsText("");
    setOpen(true);
  };

  const onCreate = async () => {
    const options =
      form.fieldType === "select"
        ? optionsText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    setSaving(true);
    try {
      const { ok } = await create({
        entity: form.entity,
        key: form.key,
        label: form.label,
        field_type: form.fieldType,
        options,
        required: form.required,
      });
      if (ok) {
        toast.success("Custom field added");
        setOpen(false);
        await reload();
      } else {
        toast.toast({
          title: "Not available yet",
          description: "Custom fields persist once the API ships.",
        });
      }
    } catch (e) {
      toast.error("Could not add field", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (def: CustomFieldDefinitionDto) => {
    try {
      const { ok } = await update(def.id, { archived: !def.archived });
      if (ok) {
        toast.success(def.archived ? "Field restored" : "Field archived");
        await reload();
      } else {
        toast.toast({ title: "Not available yet" });
      }
    } catch (e) {
      toast.error("Could not update field", e instanceof Error ? e.message : undefined);
    }
  };

  const columns = [
    {
      key: "label",
      header: "Field",
      cell: (d: CustomFieldDefinitionDto) => (
        <span className={styles.fieldCell}>
          <span className={styles.fieldLabel}>{d.label}</span>
          <span className={styles.fieldKey}>{d.key}</span>
        </span>
      ),
      sortValue: (d: CustomFieldDefinitionDto) => d.label,
    },
    {
      key: "type",
      header: "Type",
      cell: (d: CustomFieldDefinitionDto) =>
        FIELD_TYPE_OPTIONS.find((o) => o.value === d.fieldType)?.label ?? d.fieldType,
    },
    {
      key: "required",
      header: "Required",
      cell: (d: CustomFieldDefinitionDto) => (d.required ? "Yes" : "No"),
    },
    {
      key: "status",
      header: "Status",
      cell: (d: CustomFieldDefinitionDto) => (
        <StatusBadge tone={d.archived ? "muted" : "success"}>
          {d.archived ? "Archived" : "Active"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right" as const,
      cell: (d: CustomFieldDefinitionDto) => (
        <TpButton variant="ghost" size="sm" onClick={() => toggleArchive(d)}>
          {d.archived ? "Restore" : "Archive"}
        </TpButton>
      ),
    },
  ];

  return (
    <section>
      <h1 className="tp-settings-title">Custom fields</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        <FormSection
          title="Workspace custom fields"
          description="Define typed fields shown on every contact or account record in this workspace."
        >
          <div className={styles.toolbar}>
            <SegmentedControl
              items={[...ENTITY_TABS]}
              value={entity}
              onChange={(v) => setEntity(v as "contact" | "account")}
              aria-label="Record type"
            />
            <TpButton
              variant="primary"
              size="sm"
              leftIcon={<Plus size={15} />}
              onClick={openCreate}
            >
              Add field
            </TpButton>
          </div>

          {!available ? (
            <span className={styles.note}>Connect the custom-fields API to manage fields.</span>
          ) : null}

          <DataTable<CustomFieldDefinitionDto>
            columns={columns}
            rows={definitions}
            rowKey={(d) => d.id}
            empty={
              <EmptyState
                title="No custom fields yet"
                description="Add your first field to capture data beyond the standard record."
                action={
                  <TpButton size="sm" leftIcon={<Plus size={15} />} onClick={openCreate}>
                    Add field
                  </TpButton>
                }
              />
            }
          />
        </FormSection>
      </StateSwitch>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add custom field"
        maxWidth={520}
        footer={
          <div className={styles.dialogFooter}>
            <TpButton variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </TpButton>
            <TpButton onClick={onCreate} loading={saving} disabled={!canSave}>
              Save field
            </TpButton>
          </div>
        }
      >
        <FieldGroup label="Record type" htmlFor="cf-entity">
          <TpSelect
            id="cf-entity"
            value={form.entity}
            onChange={(e) => set("entity", e.target.value as CustomFieldForm["entity"])}
          >
            <option value="contact">Contact</option>
            <option value="account">Account</option>
          </TpSelect>
        </FieldGroup>
        <FieldGroup
          label="Label"
          htmlFor="cf-label"
          hint="Shown on the record (e.g. Account Tier)."
        >
          <TpInput
            id="cf-label"
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="Account Tier"
          />
        </FieldGroup>
        <FieldGroup
          label="Key"
          htmlFor="cf-key"
          hint="Immutable storage key — lowercase letters, digits, underscores."
        >
          <TpInput
            id="cf-key"
            value={form.key}
            onChange={(e) => set("key", e.target.value)}
            placeholder="account_tier"
          />
        </FieldGroup>
        <FieldGroup label="Type" htmlFor="cf-type">
          <TpSelect
            id="cf-type"
            value={form.fieldType}
            onChange={(e) => set("fieldType", e.target.value as CustomFieldForm["fieldType"])}
          >
            {FIELD_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </TpSelect>
        </FieldGroup>
        {form.fieldType === "select" ? (
          <FieldGroup label="Options" htmlFor="cf-options" hint="One option per line.">
            <TpTextarea
              id="cf-options"
              rows={4}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder={"gold\nsilver\nbronze"}
            />
          </FieldGroup>
        ) : null}
        <FieldGroup label="Required" htmlFor="cf-required" hint="Require a value on this field.">
          <TpSwitch
            id="cf-required"
            checked={form.required}
            onChange={(e) => set("required", e.target.checked)}
          />
        </FieldGroup>
      </Dialog>
    </section>
  );
}
