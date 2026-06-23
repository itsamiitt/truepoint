// IdentityPanel.tsx — the Tenant ▸ Security ▸ Domains & SCIM surface (enterprise IAM, 17 / ADR-0017/0018):
// the org claims + verifies DNS domains (which drive SSO routing / auto-join) and mints/revokes the SCIM
// bearer tokens its identity provider uses to provision users. Tenant-scoped; the API (requireOrgRole)
// returns 403 for everyone but owner/security_admin, surfaced here as a quiet "Security admin required"
// empty state. Presentation + view state only — data loads via useIdentity → identityApi.
//
// SECURITY: a minted SCIM token's plaintext is returned by the API exactly ONCE. The panel surfaces it in a
// dialog with a copy hint and a "you won't see it again" warning; it is never re-fetched or re-shown.
"use client";

import type { DomainView, ScimTokenCreated, ScimTokenView } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  FormSection,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useIdentity } from "../hooks/useIdentity";
import styles from "../settings-tenant.module.css";

const JOIN_POLICY_LABEL: Record<DomainView["joinPolicy"], string> = {
  sso_only: "SSO only",
  auto_join: "Auto-join",
  request_access: "Request access",
};

function domainTone(status: DomainView["status"]): StatusTone {
  if (status === "verified") return "success";
  if (status === "failed") return "danger";
  return "warning"; // pending
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function IdentityPanel() {
  const toast = useToast();
  const {
    domains,
    tokens,
    forbidden,
    error,
    loading,
    reload,
    claim,
    verify,
    createToken,
    revokeToken,
  } = useIdentity();

  const [domainInput, setDomainInput] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const [tokenName, setTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [minted, setMinted] = useState<ScimTokenCreated | null>(null);

  const onClaim = async () => {
    const domain = domainInput.trim().toLowerCase();
    if (!domain) return;
    setClaiming(true);
    try {
      await claim(domain);
      setDomainInput("");
      toast.success("Domain claimed", "Publish the DNS TXT record, then verify.");
    } catch (e) {
      toast.error("Could not claim domain", e instanceof Error ? e.message : undefined);
    } finally {
      setClaiming(false);
    }
  };

  const onVerify = async (id: string) => {
    setVerifyingId(id);
    try {
      await verify(id);
      toast.success("Domain verified");
    } catch (e) {
      toast.error("Could not verify domain", e instanceof Error ? e.message : undefined);
    } finally {
      setVerifyingId(null);
    }
  };

  const onCreate = async () => {
    const name = tokenName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createToken(name);
      setTokenName("");
      setMinted(created); // show the plaintext once
    } catch (e) {
      toast.error("Could not create token", e instanceof Error ? e.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      await revokeToken(id);
      toast.success("Token revoked");
    } catch (e) {
      toast.error("Could not revoke token", e instanceof Error ? e.message : undefined);
    } finally {
      setRevokingId(null);
    }
  };

  const copyToken = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      toast.success("Copied to clipboard");
    } catch {
      toast.toast({ title: "Copy manually", description: "Select the token and copy it." });
    }
  };

  const domainColumns: Column<DomainView>[] = [
    {
      key: "domain",
      header: "Domain",
      sortValue: (d) => d.domain,
      cell: (d) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{d.domain}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (d) => d.status,
      cell: (d) => <StatusBadge tone={domainTone(d.status)}>{d.status}</StatusBadge>,
    },
    {
      key: "joinPolicy",
      header: "Join policy",
      sortValue: (d) => d.joinPolicy,
      cell: (d) => JOIN_POLICY_LABEL[d.joinPolicy],
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (d) =>
        d.status === "pending" ? (
          <TpButton
            variant="secondary"
            onClick={() => void onVerify(d.id)}
            loading={verifyingId === d.id}
          >
            Verify
          </TpButton>
        ) : (
          <span className={styles.note}>{shortDate(d.verifiedAt)}</span>
        ),
    },
  ];

  const tokenColumns: Column<ScimTokenView>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (t) => t.name,
      cell: (t) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.name}</span>,
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (t) => t.createdAt,
      cell: (t) => <span className="tp-cell-mono">{shortDate(t.createdAt)}</span>,
    },
    {
      key: "lastUsedAt",
      header: "Last used",
      sortValue: (t) => t.lastUsedAt ?? "",
      cell: (t) => <span className="tp-cell-mono">{shortDate(t.lastUsedAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (t) => (t.revokedAt ? "revoked" : "active"),
      cell: (t) =>
        t.revokedAt ? (
          <StatusBadge tone="muted">Revoked</StatusBadge>
        ) : (
          <StatusBadge tone="success">Active</StatusBadge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (t) =>
        t.revokedAt ? null : (
          <TpButton
            variant="secondary"
            onClick={() => void onRevoke(t.id)}
            loading={revokingId === t.id}
          >
            Revoke
          </TpButton>
        ),
    },
  ];

  return (
    <section>
      <h1 className="tp-settings-title">Domains &amp; SCIM</h1>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {forbidden ? (
          <EmptyState
            icon={<ShieldCheck size={28} />}
            title="Security admin required"
            description="Only an organization owner or security admin can manage domains and SCIM provisioning."
          />
        ) : (
          <>
            <FormSection
              title="Domains"
              description="Claim a DNS domain and verify ownership to drive SSO routing and auto-join for users at that domain."
            >
              <FieldGroup
                label="Claim a domain"
                htmlFor="domain"
                hint="Enter a domain you control (e.g. acme.com), then publish the DNS TXT record we generate and verify it."
              >
                <div className={styles.identityRow}>
                  <div className={styles.identityField}>
                    <TpInput
                      id="domain"
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="acme.com"
                      autoComplete="off"
                    />
                  </div>
                  <TpButton onClick={onClaim} loading={claiming} disabled={!domainInput.trim()}>
                    Claim domain
                  </TpButton>
                </div>
              </FieldGroup>

              <DataTable
                columns={domainColumns}
                rows={domains}
                rowKey={(d) => d.id}
                empty={
                  <EmptyState
                    icon={<ShieldCheck size={20} />}
                    title="No domains claimed"
                    description="Claim a domain above to enable SSO routing and auto-join."
                  />
                }
              />
            </FormSection>

            <FormSection
              title="SCIM provisioning tokens"
              description="Bearer tokens your identity provider uses to provision and de-provision users via SCIM 2.0. A token is shown only once when created."
            >
              <FieldGroup
                label="Generate a token"
                htmlFor="token-name"
                hint="Give the token a name you'll recognize (e.g. the IdP it belongs to)."
              >
                <div className={styles.identityRow}>
                  <div className={styles.identityField}>
                    <TpInput
                      id="token-name"
                      value={tokenName}
                      onChange={(e) => setTokenName(e.target.value)}
                      placeholder="Okta production"
                      maxLength={100}
                      autoComplete="off"
                    />
                  </div>
                  <TpButton onClick={onCreate} loading={creating} disabled={!tokenName.trim()}>
                    Generate token
                  </TpButton>
                </div>
              </FieldGroup>

              <DataTable
                columns={tokenColumns}
                rows={tokens}
                rowKey={(t) => t.id}
                empty={
                  <EmptyState
                    icon={<KeyRound size={20} />}
                    title="No SCIM tokens"
                    description="Generate a token above to connect your identity provider."
                  />
                }
              />
            </FormSection>
          </>
        )}
      </StateSwitch>

      <Dialog
        open={minted != null}
        onClose={() => setMinted(null)}
        title="Copy your SCIM token"
        description="This is the only time the token is shown. Store it in your identity provider now — you won't be able to see it again."
        footer={
          <>
            <TpButton variant="secondary" onClick={() => void copyToken()}>
              Copy
            </TpButton>
            <TpButton onClick={() => setMinted(null)}>Done</TpButton>
          </>
        }
      >
        {minted ? (
          <FieldGroup label={minted.name} htmlFor="minted-token">
            <TpInput
              id="minted-token"
              readOnly
              value={minted.token}
              onFocus={(e) => e.target.select()}
            />
          </FieldGroup>
        ) : null}
      </Dialog>
    </section>
  );
}
