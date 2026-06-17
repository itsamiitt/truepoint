// WorkspaceGeneralPanel.tsx — the Workspace ▸ General settings form (name / slug / region / timezone). Dirty
// state is kept locally and saved via the documented contract; if the backend isn't built the Save toasts a
// quiet "not available yet" (no fake persistence).
"use client";

import { FieldGroup, FormSection, StateSwitch, TpButton, TpInput, TpSelect, useToast } from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { REGIONS, TIMEZONES, type WorkspaceGeneral } from "../types";
import styles from "../settings-workspace.module.css";

const EMPTY: WorkspaceGeneral = { name: "", slug: "", region: "us", timezone: "UTC" };

export function WorkspaceGeneralPanel() {
  const toast = useToast();
  const { data, available, error, loading, reload, save } = useWorkspace();
  const [form, setForm] = useState<WorkspaceGeneral>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const set = (key: keyof WorkspaceGeneral, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSave = async () => {
    setSaving(true);
    try {
      const ok = await save(form);
      if (ok) toast.success("Workspace updated");
      else
        toast.toast({
          title: "Not available yet",
          description: "Workspace settings persist once the API ships.",
        });
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h1 className="tp-settings-title">Workspace</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        <FormSection title="General" description="Your workspace identity and default data region.">
          <FieldGroup label="Name" htmlFor="ws-name">
            <TpInput
              id="ws-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Acme Sales"
            />
          </FieldGroup>
          <FieldGroup label="Workspace URL slug" htmlFor="ws-slug" hint="Used in workspace links.">
            <TpInput
              id="ws-slug"
              value={form.slug}
              onChange={(e) => set("slug", e.target.value)}
              placeholder="acme-sales"
            />
          </FieldGroup>
          <FieldGroup
            label="Default region"
            htmlFor="ws-region"
            hint="Where this workspace's data lives."
          >
            <TpSelect id="ws-region" value={form.region} onChange={(e) => set("region", e.target.value)}>
              {REGIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </TpSelect>
          </FieldGroup>
          <FieldGroup label="Timezone" htmlFor="ws-tz">
            <TpSelect id="ws-tz" value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </TpSelect>
          </FieldGroup>
          <div className={styles.formActions}>
            {!available ? (
              <span className={styles.note}>Connect the workspace API to persist changes.</span>
            ) : null}
            <TpButton onClick={onSave} loading={saving}>
              Save changes
            </TpButton>
          </div>
        </FormSection>
      </StateSwitch>
    </section>
  );
}
