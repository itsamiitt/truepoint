// AutoEnrichPanel.tsx — the Workspace ▸ Auto-enrich settings form (G-ENR-1; 29 §3). Toggle auto-enrich on,
// choose which events trigger it (on import / on reveal / on stale), bound it to a field allowlist, and set
// a monthly credit budget cap. Dirty state is local and saved via the documented contract; if the backend
// isn't built the Save toasts a quiet "not available yet" (no fake persistence). Presentation + view state
// only — data loads via useAutoEnrichPolicy → api. Color comes from --tp-* tokens via @leadwolf/ui.
"use client";

import type { EnrichField, EnrichTrigger } from "@leadwolf/types";
import {
  FieldGroup,
  FormSection,
  StateSwitch,
  TpButton,
  TpCheckbox,
  TpInput,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { useAutoEnrichPolicy } from "../hooks/useAutoEnrichPolicy";
import styles from "../settings-enrichment.module.css";
import {
  type AutoEnrichPolicy,
  FIELD_OPTIONS,
  TRIGGER_OPTIONS,
  creditsToMicros,
  microsToCredits,
} from "../types";

interface FormState {
  enabled: boolean;
  triggers: EnrichTrigger[];
  fieldAllowlist: EnrichField[];
  monthlyBudgetCredits: number;
}

function toForm(p: AutoEnrichPolicy): FormState {
  return {
    enabled: p.enabled,
    triggers: p.triggers,
    fieldAllowlist: p.fieldAllowlist,
    monthlyBudgetCredits: microsToCredits(p.monthlyBudgetMicros),
  };
}

const EMPTY: FormState = {
  enabled: false,
  triggers: [],
  fieldAllowlist: [],
  monthlyBudgetCredits: 0,
};

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function AutoEnrichPanel() {
  const toast = useToast();
  const { data, available, error, loading, reload, save } = useAutoEnrichPolicy();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  const onSave = async () => {
    setSaving(true);
    try {
      const ok = await save({
        enabled: form.enabled,
        triggers: form.triggers,
        fieldAllowlist: form.fieldAllowlist,
        monthlyBudgetMicros: creditsToMicros(form.monthlyBudgetCredits),
      });
      if (ok) toast.success("Auto-enrich policy saved");
      else
        toast.toast({
          title: "Not available yet",
          description: "The auto-enrich policy persists once the API ships.",
        });
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const spentCredits = data ? microsToCredits(data.monthlySpentMicros) : 0;

  return (
    <section>
      <h1 className="tp-settings-title">Auto-enrich</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        <FormSection
          title="Auto-enrich policy"
          description="Decide when enrichment fires automatically, which fields it may fill, and the monthly spend it can use."
        >
          <FieldGroup
            label="Enable auto-enrich"
            htmlFor="ae-enabled"
            hint="Off by default — you stay in control of spend."
          >
            <TpSwitch
              id="ae-enabled"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
          </FieldGroup>

          <FieldGroup label="Triggers" hint="When auto-enrich is allowed to run.">
            <div className={styles.optionList}>
              {TRIGGER_OPTIONS.map((opt) => (
                <TpCheckbox
                  key={opt.value}
                  label={
                    <span>
                      {opt.label}
                      <span className={styles.optionHint}>{opt.hint}</span>
                    </span>
                  }
                  checked={form.triggers.includes(opt.value)}
                  disabled={!form.enabled}
                  onChange={() =>
                    setForm((f) => ({ ...f, triggers: toggle(f.triggers, opt.value) }))
                  }
                />
              ))}
            </div>
          </FieldGroup>

          <FieldGroup label="Field allowlist" hint="Only these fields may be auto-filled.">
            <div className={styles.optionList}>
              {FIELD_OPTIONS.map((opt) => (
                <TpCheckbox
                  key={opt.value}
                  label={opt.label}
                  checked={form.fieldAllowlist.includes(opt.value)}
                  disabled={!form.enabled}
                  onChange={() =>
                    setForm((f) => ({ ...f, fieldAllowlist: toggle(f.fieldAllowlist, opt.value) }))
                  }
                />
              ))}
            </div>
          </FieldGroup>

          <FieldGroup
            label="Monthly budget (credits)"
            htmlFor="ae-budget"
            hint={
              data
                ? `Used this month: ${spentCredits.toLocaleString()} credits.`
                : "Auto-enrich stops once this cap is reached."
            }
          >
            <TpInput
              id="ae-budget"
              type="number"
              min={0}
              step={1}
              value={String(form.monthlyBudgetCredits)}
              disabled={!form.enabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, monthlyBudgetCredits: Number(e.target.value) || 0 }))
              }
            />
          </FieldGroup>

          <div className={styles.formActions}>
            {!available ? (
              <span className={styles.note}>Connect the settings API to persist changes.</span>
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
