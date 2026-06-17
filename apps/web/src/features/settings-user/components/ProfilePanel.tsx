// ProfilePanel.tsx — Settings ▸ User ▸ Profile (12 §2): name / avatar preview / timezone / locale, saved via
// PATCH /settings/user/profile. Load states go through StateSwitch; the form is dirty-aware (Save disabled when
// pristine) and surfaces a useToast().success on save. If the backend isn't wired yet the failing load shows a
// first-class ErrorState with retry — we never invent a profile. Public-ish; mounted by the route page.
"use client";

import { Avatar, FieldGroup, FormSection, StateSwitch, TpButton, TpInput, TpSelect, useToast } from "@leadwolf/ui";
import { useEffect, useMemo, useState } from "react";
import { saveProfile } from "../api";
import { useProfile } from "../hooks/useProfile";
import type { UserProfile } from "../types";
import styles from "../settings-user.module.css";
import { LOCALE_OPTIONS, TIMEZONE_OPTIONS } from "./options";

interface Draft {
  name: string;
  timezone: string;
  locale: string;
}

function draftFrom(p: UserProfile): Draft {
  return { name: p.name, timezone: p.timezone, locale: p.locale };
}

export function ProfilePanel() {
  const { data, loading, error, reload } = useProfile();
  const { success, error: toastError } = useToast();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the editable draft once the profile loads (and re-seed on reload).
  useEffect(() => {
    if (data) setDraft(draftFrom(data));
  }, [data]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return draft.name !== data.name || draft.timezone !== data.timezone || draft.locale !== data.locale;
  }, [data, draft]);

  const nameInvalid = draft != null && draft.name.trim().length === 0;

  async function onSave() {
    if (!draft || nameInvalid) return;
    setSaving(true);
    try {
      await saveProfile({
        name: draft.name.trim(),
        timezone: draft.timezone,
        locale: draft.locale,
      });
      success("Profile saved");
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Could not save your profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.panel}>
      <h1 className="tp-settings-title">Profile</h1>

      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {data && draft ? (
          <>
            <FormSection
              title="Your details"
              description="How you appear across the workspace. Your sign-in email is managed on the sign-in site."
            >
              <div className={styles.identityRow}>
                <Avatar name={draft.name || data.email} size={48} />
                <div className={styles.identityMeta}>
                  <span className={styles.identityName}>{draft.name || "Unnamed"}</span>
                  <span className={styles.identityEmail}>{data.email}</span>
                </div>
              </div>

              <FieldGroup
                label="Full name"
                htmlFor="profile-name"
                error={nameInvalid ? "Name can't be empty" : undefined}
              >
                <TpInput
                  id="profile-name"
                  value={draft.name}
                  invalid={nameInvalid}
                  autoComplete="name"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </FieldGroup>

              <FieldGroup
                label="Email"
                htmlFor="profile-email"
                hint="Your verified sign-in email — change it on the sign-in site."
              >
                <TpInput id="profile-email" value={data.email} readOnly disabled />
              </FieldGroup>
            </FormSection>

            <FormSection
              title="Regional"
              description="Used for date, time, and number formatting across the app."
            >
              <div className={styles.grid2}>
                <FieldGroup label="Timezone" htmlFor="profile-timezone">
                  <TpSelect
                    id="profile-timezone"
                    value={draft.timezone}
                    onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  >
                    {/* Keep an unknown server value selectable so we never silently overwrite it. */}
                    {!TIMEZONE_OPTIONS.some((o) => o.value === draft.timezone) ? (
                      <option value={draft.timezone}>{draft.timezone}</option>
                    ) : null}
                    {TIMEZONE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </TpSelect>
                </FieldGroup>

                <FieldGroup label="Locale" htmlFor="profile-locale">
                  <TpSelect
                    id="profile-locale"
                    value={draft.locale}
                    onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
                  >
                    {!LOCALE_OPTIONS.some((o) => o.value === draft.locale) ? (
                      <option value={draft.locale}>{draft.locale}</option>
                    ) : null}
                    {LOCALE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </TpSelect>
                </FieldGroup>
              </div>
            </FormSection>

            <div className={styles.actions}>
              <TpButton onClick={onSave} loading={saving} disabled={!dirty || nameInvalid}>
                Save changes
              </TpButton>
              {dirty && !saving ? (
                <span className={styles.savedHint}>Unsaved changes</span>
              ) : null}
            </div>
          </>
        ) : null}
      </StateSwitch>
    </section>
  );
}
