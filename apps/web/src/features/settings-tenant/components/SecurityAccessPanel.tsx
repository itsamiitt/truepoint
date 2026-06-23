// SecurityAccessPanel.tsx — the Tenant ▸ Security & access surface (ADR-0018, 17 §10): the org-wide auth
// policy a security_admin/owner sets — MFA enforcement, allowed login methods, enforce-SSO, disable-social,
// session timeout, and an IP allowlist (CIDR per line). Tenant-scoped; the API (requireOrgRole) returns 403
// for everyone else, surfaced here as a quiet "Security admin required" empty state. Presentation + view
// state only — data loads via useAuthPolicy → api; the strictest-wins resolution at login lives in the API.
"use client";

import type { AuthMethod, AuthPolicy, MfaEnforcement } from "@leadwolf/types";
import {
  EmptyState,
  FieldGroup,
  FormSection,
  StateSwitch,
  TpButton,
  TpCheckbox,
  TpInput,
  TpSelect,
  TpSwitch,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuthPolicy } from "../hooks/useAuthPolicy";
import styles from "../settings-tenant.module.css";
import { AuthAuditList } from "./AuthAuditList";

const MFA_OPTIONS: { value: MfaEnforcement; label: string }[] = [
  { value: "off", label: "Off — MFA is not offered" },
  { value: "optional", label: "Optional — users may enroll" },
  { value: "required", label: "Required — every user must enroll" },
];
const METHOD_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "oauth", label: "Social / OAuth" },
  { value: "magic_link", label: "Magic link" },
  { value: "sso", label: "SSO (SAML / OIDC)" },
  { value: "passkey", label: "Passkey" },
];

interface FormState {
  mfaEnforcement: MfaEnforcement;
  allowedMethods: AuthMethod[];
  requireSso: boolean;
  disableSocial: boolean;
  ipAllowlistText: string; // one CIDR per line
  sessionTimeoutMinutes: number; // 0 = no timeout
}

const EMPTY: FormState = {
  mfaEnforcement: "optional",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  requireSso: false,
  disableSocial: false,
  ipAllowlistText: "",
  sessionTimeoutMinutes: 0,
};

function toForm(p: AuthPolicy): FormState {
  return {
    mfaEnforcement: p.mfaEnforcement,
    allowedMethods: p.allowedMethods,
    requireSso: p.requireSso,
    disableSocial: p.disableSocial,
    ipAllowlistText: (p.ipAllowlist ?? []).join("\n"),
    sessionTimeoutMinutes: p.sessionTimeoutSeconds ? Math.round(p.sessionTimeoutSeconds / 60) : 0,
  };
}

function toPolicy(f: FormState): AuthPolicy {
  const ipAllowlist = f.ipAllowlistText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const policy: AuthPolicy = {
    mfaEnforcement: f.mfaEnforcement,
    allowedMethods: f.allowedMethods,
    disableSocial: f.disableSocial,
    requireSso: f.requireSso,
    ipAllowlist,
  };
  if (f.sessionTimeoutMinutes > 0) policy.sessionTimeoutSeconds = f.sessionTimeoutMinutes * 60;
  return policy;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function SecurityAccessPanel() {
  const toast = useToast();
  const { policy, forbidden, error, loading, reload, save } = useAuthPolicy();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (policy) setForm(toForm(policy));
  }, [policy]);

  const onSave = async () => {
    setSaving(true);
    try {
      const ok = await save(toPolicy(form));
      if (ok) toast.success("Security policy saved");
      else
        toast.toast({ title: "Not available yet", description: "The auth API is not connected." });
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h1 className="tp-settings-title">Security &amp; access</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {forbidden ? (
          <EmptyState
            icon={<ShieldCheck size={28} />}
            title="Security admin required"
            description="Only an organization owner or security admin can view and change the authentication policy."
          />
        ) : (
          <>
            <FormSection
              title="Authentication policy"
              description="Org-wide login rules. Workspaces may only make these stricter, never looser."
            >
              <FieldGroup
                label="Multi-factor authentication"
                htmlFor="mfa"
                hint="Applies to every member of this organization."
              >
                <TpSelect
                  id="mfa"
                  value={form.mfaEnforcement}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, mfaEnforcement: e.target.value as MfaEnforcement }))
                  }
                >
                  {MFA_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </TpSelect>
              </FieldGroup>

              <FieldGroup
                label="Allowed login methods"
                hint="Members may sign in only with the methods you enable."
              >
                <div className={styles.optionList}>
                  {METHOD_OPTIONS.map((o) => (
                    <TpCheckbox
                      key={o.value}
                      label={o.label}
                      checked={form.allowedMethods.includes(o.value)}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          allowedMethods: toggle(f.allowedMethods, o.value),
                        }))
                      }
                    />
                  ))}
                </div>
              </FieldGroup>

              <FieldGroup
                label="Require SSO"
                htmlFor="require-sso"
                hint="Force members onto your identity provider."
              >
                <TpSwitch
                  id="require-sso"
                  checked={form.requireSso}
                  onChange={(e) => setForm((f) => ({ ...f, requireSso: e.target.checked }))}
                />
              </FieldGroup>

              <FieldGroup
                label="Disable social sign-in"
                htmlFor="disable-social"
                hint="Block Google/Microsoft OAuth even if allowed above."
              >
                <TpSwitch
                  id="disable-social"
                  checked={form.disableSocial}
                  onChange={(e) => setForm((f) => ({ ...f, disableSocial: e.target.checked }))}
                />
              </FieldGroup>

              <FieldGroup
                label="Session timeout (minutes)"
                htmlFor="session-timeout"
                hint="0 keeps the platform default. Members are signed out after this idle period."
              >
                <TpInput
                  id="session-timeout"
                  type="number"
                  min={0}
                  step={1}
                  value={String(form.sessionTimeoutMinutes)}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sessionTimeoutMinutes: Number(e.target.value) || 0 }))
                  }
                />
              </FieldGroup>

              <FieldGroup
                label="IP allowlist"
                htmlFor="ip-allowlist"
                hint="One CIDR per line (e.g. 203.0.113.0/24). Empty allows any IP."
              >
                <TpTextarea
                  id="ip-allowlist"
                  rows={4}
                  value={form.ipAllowlistText}
                  onChange={(e) => setForm((f) => ({ ...f, ipAllowlistText: e.target.value }))}
                  placeholder={"203.0.113.0/24\n198.51.100.7/32"}
                />
              </FieldGroup>

              <div className={styles.formActions}>
                <TpButton onClick={onSave} loading={saving}>
                  Save changes
                </TpButton>
              </div>
            </FormSection>
            <FormSection
              title="Recent security events"
              description="The latest sign-ins, MFA challenges, SSO callbacks, and session changes across your organization."
            >
              <AuthAuditList />
            </FormSection>
          </>
        )}
      </StateSwitch>
    </section>
  );
}
