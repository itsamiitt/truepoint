// SecurityPanel.tsx — Settings ▸ User ▸ Security (12 §2). IMPORTANT: password, MFA, sessions, devices, and
// login history are all served on the auth origin (auth.truepoint.in/account/security, 17 §10). This panel is
// therefore a read-only map of those surfaces with "Manage on the sign-in site" deep links — it NEVER fakes a
// mutation. The auth-origin surface is now LIVE (P1-02): each deep link resolves to a real section
// (#password / #mfa / #sessions / #history) where the user manages the setting.
//
// Live enrollment state: the auth origin holds the source of truth (user_mfa_methods) but exposes NO app-API
// read of it to apps/web yet — a cross-origin auth→app-API MFA-status endpoint is a separate, security-reviewed
// item (it must not leak factor presence cross-tenant). Until that lands, this panel shows NO per-factor On/Off
// state at all (AUTH-068): the previous hard-coded `enrolled: false` catalogue falsely told a user who HAD
// two-step on that they had none. Instead it points to the auth origin, where the real status lives and is
// managed. Wiring a `GET enrolled-methods` read here is the tracked follow-up (0.6 real-read, "once it lands").
"use client";

import { authSecurityUrl } from "@/lib/authLink";
import { AUTH_ORIGIN } from "@/lib/publicConfig";
import { FormSection, Icon } from "@leadwolf/ui";
import { ExternalLink, History, KeyRound, Monitor, ShieldCheck } from "lucide-react";
import styles from "../settings-user.module.css";

/** Deep-link to a section of the auth-origin account-security screen (17 §10). The auth app serves under the
 *  "/auth" basePath, so authSecurityUrl adds it — without the prefix these links 404 (AUTH-062). */
function authLink(section: string): string {
  return authSecurityUrl(AUTH_ORIGIN, section);
}

export function SecurityPanel() {
  return (
    <section className={styles.panel}>
      <h1 className="tp-settings-title">Security</h1>

      <div className={styles.managedNote}>
        <span className={styles.managedNoteIcon}>
          <Icon icon={ShieldCheck} size={18} />
        </span>
        <span>
          Your sign-in security is managed on the secure sign-in site (auth.truepoint.in). Use the
          links below to update your password, two-step methods, sessions, and devices there.
        </span>
      </div>

      {/* ── Password ─────────────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Password"
        description="Set or change the password used to sign in to TruePoint."
      >
        <div className={styles.statusRow}>
          <div className={styles.statusEnd} style={{ flex: 1, minWidth: 0 }}>
            <span className={styles.statusMeta}>
              <span className={styles.statusTitle}>Password</span>
              <span className={styles.statusDetail}>
                Argon2id-hashed with a strength meter on the sign-in site.
              </span>
            </span>
          </div>
          <a
            className="tp-ui-btn tp-ui-btn--secondary tp-ui-btn--sm"
            href={authLink("password")}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon icon={KeyRound} size={14} />
            Change password
            <Icon icon={ExternalLink} size={13} />
          </a>
        </div>
      </FormSection>

      {/* ── Two-step (MFA) ───────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Two-step verification"
        description="Add a second factor so a password alone can't unlock your account."
      >
        <div className={styles.statusRow}>
          <span className={styles.statusMeta}>
            <span className={styles.statusTitle}>Two-step methods</span>
            <span className={styles.statusDetail}>
              Set up an authenticator app and recovery codes — and see which factors are on — on the
              sign-in site.
            </span>
          </span>
          <a
            className="tp-ui-btn tp-ui-btn--secondary tp-ui-btn--sm"
            href={authLink("mfa")}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon icon={ShieldCheck} size={14} />
            Manage two-step methods
            <Icon icon={ExternalLink} size={13} />
          </a>
        </div>
      </FormSection>

      {/* ── Sessions & devices ───────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Sessions & devices"
        description="Review where you're signed in, trusted devices, and sign out everywhere."
      >
        <div className={styles.statusRow}>
          <span className={styles.statusMeta}>
            <span className={styles.statusTitle}>Active sessions & trusted devices</span>
            <span className={styles.statusDetail}>
              View active sessions, revoke trusted devices, and sign out everywhere.
            </span>
          </span>
          <a
            className="tp-ui-btn tp-ui-btn--secondary tp-ui-btn--sm"
            href={authLink("sessions")}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon icon={Monitor} size={14} />
            Manage sessions
            <Icon icon={ExternalLink} size={13} />
          </a>
        </div>
      </FormSection>

      {/* ── Login history ────────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Login history"
        description="Recent sign-in events — time, device, location, and the origin domain."
      >
        <div className={styles.statusRow}>
          <span className={styles.statusMeta}>
            <span className={styles.statusTitle}>Recent activity</span>
            <span className={styles.statusDetail}>
              The full event log lives on the sign-in site.
            </span>
          </span>
          <a
            className="tp-ui-btn tp-ui-btn--secondary tp-ui-btn--sm"
            href={authLink("history")}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon icon={History} size={14} />
            View login history
            <Icon icon={ExternalLink} size={13} />
          </a>
        </div>
      </FormSection>
    </section>
  );
}
