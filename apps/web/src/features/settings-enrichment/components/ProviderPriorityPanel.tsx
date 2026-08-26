// ProviderPriorityPanel.tsx — the Workspace ▸ Enrichment providers settings form (waterfall v2 / 0111;
// 06 §4 "the ordering is configurable, not hardcoded — per-field provider preferences are data") [S-04]
// [S-08]. Per-FIELD ordered lists (the email order and the phone order are independent), reordered with
// UP/DOWN ARROW BUTTONS + a numeric position — deliberately not drag-and-drop: the monorepo carries no
// dnd dependency and buttons are keyboard-accessible by construction (truepoint-design WCAG posture).
// Providers can be disabled workspace-wide, and the verify-before-accept knobs (email verification +
// catch-all handling) live here too. Presentation + view state only — persistence via the same
// useAutoEnrichPolicy PATCH seam as the auto-enrich form. Color comes from --tp-* tokens via @leadwolf/ui.
"use client";

import {
  type AcceptCatchAll,
  type EnrichProviderId,
  KNOWN_ENRICH_PROVIDERS,
  type ProviderPriority,
  type VerificationPolicy,
} from "@leadwolf/types";
import {
  FieldGroup,
  FormSection,
  PageHeader,
  StateSwitch,
  TpButton,
  TpSelect,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { useAutoEnrichPolicy } from "../hooks/useAutoEnrichPolicy";
import styles from "../settings-enrichment.module.css";

const ALL_IDS = KNOWN_ENRICH_PROVIDERS.map((p) => p.provider);

const CATCH_ALL_OPTIONS: { value: AcceptCatchAll; label: string }[] = [
  { value: "flag", label: "Accept, flagged as catch-all (default)" },
  { value: "continue", label: "Keep cascading; fall back to it only if nothing verifies" },
  { value: "accept", label: "Accept as a match" },
];

interface FormState {
  email: EnrichProviderId[];
  phone: EnrichProviderId[];
  disabled: EnrichProviderId[];
  verification: VerificationPolicy;
}

/** The stored order first, then every remaining known provider in catalog order — the same
 *  prefix-plus-remainder resolution the engine applies, so the list SHOWS the true cascade. */
function displayOrder(saved: EnrichProviderId[], disabled: EnrichProviderId[]): EnrichProviderId[] {
  const rest = ALL_IDS.filter((id) => !saved.includes(id as EnrichProviderId));
  return [...saved, ...(rest as EnrichProviderId[])].filter(
    (id) => !disabled.includes(id) || saved.includes(id),
  );
}

export function ProviderPriorityPanel() {
  const toast = useToast();
  const { data, available, error, loading, reload, save } = useAutoEnrichPolicy();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        email: displayOrder(data.providerPriority.email, data.providerPriority.disabled),
        phone: displayOrder(data.providerPriority.phone, data.providerPriority.disabled),
        disabled: data.providerPriority.disabled,
        verification: data.verification,
      });
    }
  }, [data]);

  const onSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const providerPriority: ProviderPriority = {
        version: 1,
        email: form.email,
        phone: form.phone,
        disabled: form.disabled,
      };
      const ok = await save({ providerPriority, verification: form.verification });
      if (ok) toast.success("Provider priority saved");
      else
        toast.toast({
          title: "Not available yet",
          description: "Provider priority persists once the API ships.",
        });
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <PageHeader title="Enrichment providers" />
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {form ? (
          <>
            <FormSection
              title="Data sources"
              description="TruePoint sources contact data for you and verifies it before accepting it. Which upstream sources are used, and in what order, is managed by TruePoint — you control verification below."
            >
              {null}
            </FormSection>

            <FormSection
              title="Verification"
              description="A found email is verified before it is accepted; a failed verification falls through to the next provider."
            >
              <FieldGroup
                label="Verify email before accepting"
                htmlFor="pp-verify-email"
                hint="Uses the configured verifier; without one, values land unverified (no behavior change)."
              >
                <TpSwitch
                  id="pp-verify-email"
                  checked={form.verification.verifyEmailBeforeAccept}
                  onChange={(e) =>
                    setForm(
                      (f) =>
                        f && {
                          ...f,
                          verification: {
                            ...f.verification,
                            verifyEmailBeforeAccept: e.target.checked,
                          },
                        },
                    )
                  }
                />
              </FieldGroup>
              <FieldGroup
                label="Catch-all domains"
                htmlFor="pp-catch-all"
                hint="How a catch-all verification verdict is treated."
              >
                <TpSelect
                  id="pp-catch-all"
                  value={form.verification.acceptCatchAll}
                  disabled={!form.verification.verifyEmailBeforeAccept}
                  onChange={(e) =>
                    setForm(
                      (f) =>
                        f && {
                          ...f,
                          verification: {
                            ...f.verification,
                            acceptCatchAll: e.target.value as AcceptCatchAll,
                          },
                        },
                    )
                  }
                >
                  {CATCH_ALL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </TpSelect>
              </FieldGroup>
              <FieldGroup
                label="Verify phone numbers"
                htmlFor="pp-verify-phone"
                hint="Carrier lookup where configured; metered and jurisdiction-sensitive, so off by default."
              >
                <TpSwitch
                  id="pp-verify-phone"
                  checked={form.verification.verifyPhone}
                  onChange={(e) =>
                    setForm(
                      (f) =>
                        f && {
                          ...f,
                          verification: { ...f.verification, verifyPhone: e.target.checked },
                        },
                    )
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
          </>
        ) : null}
      </StateSwitch>
    </section>
  );
}
