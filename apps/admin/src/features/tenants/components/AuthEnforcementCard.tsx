// AuthEnforcementCard.tsx — the per-tenant P1-01 auth-enforcement master switch on the tenant-detail page.
// LOCKOUT-CAPABLE: turning it ON activates the IP-allowlist / allowed-method / session+idle-timeout /
// forced-MFA login gates (combined with the global env master-arm); turning it OFF is the documented
// BREAK-GLASS that re-opens login WITHOUT a deploy. So the switch is render-gated to super_admin and every
// flip goes through a confirm Dialog with explicit copy. Render-gate is UX only — the api re-checks
// requireStaffRole("super_admin") on the write (the real boundary). Writes hit the EXISTING audited endpoint.
"use client";

import { Card, Dialog, StateSwitch, StatusBadge, TpButton, TpSwitch, useToast } from "@leadwolf/ui";
import { useState } from "react";
import { useAuthEnforcement } from "../hooks/useAuthEnforcement";
import { useIsSuperAdmin } from "../hooks/useIsSuperAdmin";
import type { TenantDetail } from "../types";

function confirmCopy(turningOn: boolean, tenantName: string) {
  return turningOn
    ? {
        title: "Enable auth enforcement?",
        body: `Turning enforcement ON tightens login for ${tenantName}: the per-tenant IP allowlist, allowed login methods, session and idle timeouts, and forced-MFA enrollment all become active (together with the global master-arm). Members whose current method, IP, or MFA state does not satisfy the policy may be locked out.`,
        confirm: "Enable enforcement",
        variant: "primary" as const,
      }
    : {
        title: "Disable auth enforcement (break-glass)?",
        body: `Turning enforcement OFF is the documented BREAK-GLASS: it immediately re-opens password and all configured login methods for ${tenantName} within the token window, bypassing the P1-01 gates — without a deploy. Use this to recover a locked-out org, then re-enable once access is restored.`,
        confirm: "Disable (break-glass)",
        variant: "danger" as const,
      };
}

export function AuthEnforcementCard({
  detail,
  onChanged,
}: {
  detail: TenantDetail;
  onChanged: () => void | Promise<void>;
}) {
  const { id: tenantId, name: tenantName } = detail.tenant;
  const { enforcementEnabled } = detail;
  const toast = useToast();
  const { isSuperAdmin, loading, error, reload } = useIsSuperAdmin();
  const { status, submit } = useAuthEnforcement(tenantId);
  // The pending target state while the confirm Dialog is open (null = closed). Not the live switch value.
  const [confirmTo, setConfirmTo] = useState<boolean | null>(null);
  const pending = status === "pending";

  async function applyEnforcement() {
    if (confirmTo == null) return;
    const next = confirmTo;
    const result = await submit(next);
    if (result == null) {
      toast.error("Could not update auth enforcement");
      return; // keep the Dialog open so the operator can retry or cancel
    }
    setConfirmTo(null);
    toast.success(result ? "Auth enforcement enabled" : "Auth enforcement disabled (break-glass)");
    await onChanged();
  }

  const copy = confirmTo == null ? null : confirmCopy(confirmTo, tenantName);

  return (
    <Card style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h3 className="tp-section-title" style={{ marginTop: 0 }}>
            Auth enforcement
          </h3>
          <p className="app-muted" style={{ maxWidth: 520 }}>
            The per-tenant master switch for the P1-01 login gates (IP allowlist, allowed methods,
            session and idle timeouts, forced MFA). Disabling is the break-glass that re-opens login.
          </p>
        </div>
        <StatusBadge tone={enforcementEnabled ? "success" : "muted"}>
          {enforcementEnabled ? "Enforced" : "Open"}
        </StatusBadge>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {isSuperAdmin ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginTop: 16 }}>
            <TpSwitch
              checked={enforcementEnabled}
              disabled={pending}
              aria-label="Toggle auth enforcement for this tenant"
              onChange={(e) => setConfirmTo(e.currentTarget.checked)}
            />
            <span style={{ color: "var(--tp-ink)" }}>
              {enforcementEnabled ? "Enforcement is on" : "Enforcement is off"}
            </span>
          </div>
        ) : (
          <p className="app-muted" style={{ marginTop: 16 }}>
            Only a super admin can change auth enforcement for a tenant.
          </p>
        )}
      </StateSwitch>

      <Dialog
        open={copy != null}
        onClose={() => {
          if (!pending) setConfirmTo(null);
        }}
        title={copy?.title}
        description={copy?.body}
        maxWidth={520}
        footer={
          <>
            <TpButton variant="secondary" disabled={pending} onClick={() => setConfirmTo(null)}>
              Cancel
            </TpButton>
            <TpButton
              variant={copy?.variant ?? "primary"}
              loading={pending}
              onClick={() => void applyEnforcement()}
            >
              {copy?.confirm}
            </TpButton>
          </>
        }
      />
    </Card>
  );
}
