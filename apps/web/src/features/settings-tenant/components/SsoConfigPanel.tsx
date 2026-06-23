// SsoConfigPanel.tsx — the Tenant ▸ Single sign-on surface (17 §7, ADR-0017/0018): the org's SAML/OIDC
// identity-provider configuration a security_admin/owner sets — protocol, provider, SAML metadata or OIDC
// issuer/client, JIT provisioning + default role, and the enable/enforce switches. Tenant-scoped; the API
// (requireOrgRole) returns 403 for everyone else, surfaced here as a quiet "Security admin required" empty
// state. The OIDC client secret is WRITE-ONLY — a stored secret shows as "Configured"; a blank field leaves
// it unchanged, and the secret is never returned to the client. Presentation + view state only.
"use client";

import type { SsoConfigUpdate, SsoConfigView } from "@leadwolf/types";
import {
  EmptyState,
  FieldGroup,
  FormSection,
  StateSwitch,
  TpButton,
  TpInput,
  TpSelect,
  TpSwitch,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useSsoConfig } from "../hooks/useSsoConfig";
import styles from "../settings-tenant.module.css";

type Protocol = "saml" | "oidc";

const PROTOCOL_OPTIONS: { value: Protocol; label: string }[] = [
  { value: "saml", label: "SAML 2.0" },
  { value: "oidc", label: "OpenID Connect (OIDC)" },
];

// Mirror @leadwolf/types orgRole — the role a JIT-provisioned SSO user is granted.
const DEFAULT_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "billing_admin", label: "Billing admin" },
  { value: "security_admin", label: "Security admin" },
  { value: "compliance_admin", label: "Compliance admin" },
  { value: "owner", label: "Owner" },
];

interface FormState {
  protocol: Protocol;
  provider: string;
  metadataUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string; // write-only — blank means "leave the stored secret unchanged"
  attributeMappingText: string; // one `key=value` per line
  defaultRole: string;
  jitEnabled: boolean;
  enabled: boolean;
  enforced: boolean;
}

const EMPTY: FormState = {
  protocol: "saml",
  provider: "",
  metadataUrl: "",
  oidcIssuer: "",
  oidcClientId: "",
  oidcClientSecret: "",
  attributeMappingText: "",
  defaultRole: "member",
  jitEnabled: true,
  enabled: false,
  enforced: false,
};

function toForm(c: SsoConfigView): FormState {
  const attributeMappingText = Object.entries(c.attributeMapping)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return {
    protocol: c.protocol,
    provider: c.provider,
    metadataUrl: c.metadataUrl ?? "",
    oidcIssuer: c.oidcIssuer ?? "",
    oidcClientId: c.oidcClientId ?? "",
    oidcClientSecret: "", // never echoed back — the field is always blank on load
    attributeMappingText,
    defaultRole: c.defaultRole,
    jitEnabled: c.jitEnabled,
    enabled: c.enabled,
    enforced: c.enforced,
  };
}

/** Parse the `key=value` lines textarea into a record (blank lines + lines without `=` are dropped). */
function parseAttributeMapping(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function toUpdate(f: FormState): SsoConfigUpdate {
  const update: SsoConfigUpdate = {
    protocol: f.protocol,
    provider: f.provider.trim(),
    metadataUrl: f.metadataUrl.trim() || null,
    oidcIssuer: f.oidcIssuer.trim() || null,
    oidcClientId: f.oidcClientId.trim() || null,
    attributeMapping: parseAttributeMapping(f.attributeMappingText),
    defaultRole: f.defaultRole as SsoConfigUpdate["defaultRole"],
    jitEnabled: f.jitEnabled,
    enabled: f.enabled,
    enforced: f.enforced,
  };
  // Only send the client secret when the admin typed one — a blank field leaves the stored secret unchanged.
  const secret = f.oidcClientSecret.trim();
  if (secret) update.oidcClientSecret = secret;
  return update;
}

export function SsoConfigPanel() {
  const toast = useToast();
  const { config, forbidden, error, loading, reload, save } = useSsoConfig();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config) setForm(toForm(config));
  }, [config]);

  const isOidc = form.protocol === "oidc";

  const onSave = async () => {
    setSaving(true);
    try {
      const ok = await save(toUpdate(form));
      if (ok) toast.success("SSO configuration saved");
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
      <h1 className="tp-settings-title">Single sign-on</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {forbidden ? (
          <EmptyState
            icon={<KeyRound size={28} />}
            title="Security admin required"
            description="Only an organization owner or security admin can view and change the SSO configuration."
          />
        ) : (
          <FormSection
            title="Identity provider"
            description="Connect your SAML 2.0 or OIDC identity provider. Members in your verified domains sign in through it."
          >
            <FieldGroup label="Protocol" htmlFor="sso-protocol">
              <TpSelect
                id="sso-protocol"
                value={form.protocol}
                onChange={(e) => setForm((f) => ({ ...f, protocol: e.target.value as Protocol }))}
              >
                {PROTOCOL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </TpSelect>
            </FieldGroup>

            <FieldGroup
              label="Provider"
              htmlFor="sso-provider"
              hint="A short label for your IdP (e.g. okta, azure-ad, onelogin)."
            >
              <TpInput
                id="sso-provider"
                value={form.provider}
                onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                placeholder="okta"
              />
            </FieldGroup>

            {!isOidc ? (
              <FieldGroup
                label="SAML metadata URL"
                htmlFor="sso-metadata-url"
                hint="The IdP metadata endpoint TruePoint fetches to configure SAML."
              >
                <TpInput
                  id="sso-metadata-url"
                  type="url"
                  value={form.metadataUrl}
                  onChange={(e) => setForm((f) => ({ ...f, metadataUrl: e.target.value }))}
                  placeholder="https://idp.example.com/app/metadata"
                />
              </FieldGroup>
            ) : (
              <>
                <FieldGroup
                  label="OIDC issuer"
                  htmlFor="sso-oidc-issuer"
                  hint="The issuer URL of your OpenID provider."
                >
                  <TpInput
                    id="sso-oidc-issuer"
                    type="url"
                    value={form.oidcIssuer}
                    onChange={(e) => setForm((f) => ({ ...f, oidcIssuer: e.target.value }))}
                    placeholder="https://idp.example.com"
                  />
                </FieldGroup>

                <FieldGroup label="OIDC client ID" htmlFor="sso-oidc-client-id">
                  <TpInput
                    id="sso-oidc-client-id"
                    value={form.oidcClientId}
                    onChange={(e) => setForm((f) => ({ ...f, oidcClientId: e.target.value }))}
                    placeholder="your-client-id"
                  />
                </FieldGroup>

                <FieldGroup
                  label="OIDC client secret"
                  htmlFor="sso-oidc-client-secret"
                  hint={
                    config?.hasClientSecret
                      ? "Configured. Leave blank to keep the current secret, or enter a new one to replace it."
                      : "Stored encrypted and never shown again. Leave blank to keep the current secret."
                  }
                >
                  <TpInput
                    id="sso-oidc-client-secret"
                    type="password"
                    autoComplete="new-password"
                    value={form.oidcClientSecret}
                    onChange={(e) => setForm((f) => ({ ...f, oidcClientSecret: e.target.value }))}
                    placeholder={config?.hasClientSecret ? "•••••••• (configured)" : ""}
                  />
                </FieldGroup>
              </>
            )}

            <FieldGroup
              label="Attribute mapping"
              htmlFor="sso-attribute-mapping"
              hint="Map IdP claims to TruePoint fields. One key=value per line (e.g. email=mail, name=displayName)."
            >
              <TpTextarea
                id="sso-attribute-mapping"
                rows={4}
                value={form.attributeMappingText}
                onChange={(e) => setForm((f) => ({ ...f, attributeMappingText: e.target.value }))}
                placeholder={"email=mail\nname=displayName"}
              />
            </FieldGroup>

            <FieldGroup
              label="Default role"
              htmlFor="sso-default-role"
              hint="The org role granted to a member provisioned via JIT."
            >
              <TpSelect
                id="sso-default-role"
                value={form.defaultRole}
                onChange={(e) => setForm((f) => ({ ...f, defaultRole: e.target.value }))}
              >
                {DEFAULT_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </TpSelect>
            </FieldGroup>

            <FieldGroup
              label="Just-in-time provisioning"
              htmlFor="sso-jit"
              hint="Create a member automatically on first SSO sign-in."
            >
              <TpSwitch
                id="sso-jit"
                checked={form.jitEnabled}
                onChange={(e) => setForm((f) => ({ ...f, jitEnabled: e.target.checked }))}
              />
            </FieldGroup>

            <FieldGroup
              label="Enable SSO"
              htmlFor="sso-enabled"
              hint="Allow members to sign in through this identity provider."
            >
              <TpSwitch
                id="sso-enabled"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
            </FieldGroup>

            <FieldGroup
              label="Enforce SSO"
              htmlFor="sso-enforced"
              hint="Require members in your verified domains to sign in through SSO."
            >
              <TpSwitch
                id="sso-enforced"
                checked={form.enforced}
                onChange={(e) => setForm((f) => ({ ...f, enforced: e.target.checked }))}
              />
            </FieldGroup>

            <div className={styles.formActions}>
              <TpButton onClick={onSave} loading={saving}>
                Save changes
              </TpButton>
            </div>
          </FormSection>
        )}
      </StateSwitch>
    </section>
  );
}
