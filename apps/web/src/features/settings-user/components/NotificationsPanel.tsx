// NotificationsPanel.tsx — Settings ▸ User ▸ Notifications (12 §2): a grid of TpSwitch toggles for the four
// events (reply / task / low-credit / digest) across the in-app + email channels, saved via PUT
// /settings/user/notifications. Load states go through StateSwitch; the form is dirty-aware and a save raises a
// useToast(). We never fake prefs — a failing load shows ErrorState with retry.
"use client";

import { FormSection, StateSwitch, TpButton, TpSwitch, useToast } from "@leadwolf/ui";
import { useEffect, useMemo, useState } from "react";
import { saveNotificationPrefs } from "../api";
import { useNotificationPrefs } from "../hooks/useNotificationPrefs";
import type { NotificationChannel, NotificationEvent, NotificationPrefs } from "../types";
import styles from "../settings-user.module.css";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "./options";

function clone(prefs: NotificationPrefs): NotificationPrefs {
  return JSON.parse(JSON.stringify(prefs)) as NotificationPrefs;
}

function equal(a: NotificationPrefs, b: NotificationPrefs): boolean {
  return NOTIFICATION_EVENTS.every(({ event }) =>
    NOTIFICATION_CHANNELS.every(({ channel }) => a[event]?.[channel] === b[event]?.[channel]),
  );
}

export function NotificationsPanel() {
  const { data, loading, error, reload } = useNotificationPrefs();
  const { success, error: toastError } = useToast();

  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(clone(data));
  }, [data]);

  const dirty = useMemo(() => (data && draft ? !equal(data, draft) : false), [data, draft]);

  function toggle(event: NotificationEvent, channel: NotificationChannel) {
    if (!draft) return;
    const next = clone(draft);
    next[event] = { ...next[event], [channel]: !next[event][channel] };
    setDraft(next);
  }

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    try {
      await saveNotificationPrefs(draft);
      success("Notification settings saved");
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Could not save your notification settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.panel}>
      <h1 className="tp-settings-title">Notifications</h1>

      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {draft ? (
          <>
            <FormSection
              title="How you're notified"
              description="Choose where each kind of update reaches you. In-app shows in the bell; email goes to your sign-in address."
            >
              <div className={styles.prefTable} role="group" aria-label="Notification preferences">
                <span className={styles.prefHead}>Event</span>
                {NOTIFICATION_CHANNELS.map((c) => (
                  <span key={c.channel} className={`${styles.prefHead} ${styles.prefHeadChannel}`}>
                    {c.label}
                  </span>
                ))}

                {NOTIFICATION_EVENTS.map(({ event, title, description }) => (
                  <div key={event} style={{ display: "contents" }}>
                    <div className={styles.prefLabel}>
                      <span className={styles.prefLabelTitle}>{title}</span>
                      <span className={styles.prefLabelDesc}>{description}</span>
                    </div>
                    {NOTIFICATION_CHANNELS.map(({ channel, label }) => (
                      <div key={channel} className={styles.prefCell}>
                        <TpSwitch
                          checked={draft[event][channel]}
                          aria-label={`${title} — ${label}`}
                          onChange={() => toggle(event, channel)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </FormSection>

            <div className={styles.actions}>
              <TpButton onClick={onSave} loading={saving} disabled={!dirty}>
                Save changes
              </TpButton>
              {dirty && !saving ? <span className={styles.savedHint}>Unsaved changes</span> : null}
            </div>
          </>
        ) : null}
      </StateSwitch>
    </section>
  );
}
