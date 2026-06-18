// OverrideDialog.tsx — manage a flag's per-tenant overrides (13 §3.5). Lists existing overrides for the
// flag (force on / force off) with a clear action, and adds a new override by tenant id. All writes go to
// the audited /admin/feature-flags/:key/tenant endpoint. Rendered by FeatureFlagsPage.
"use client";

import type { FeatureFlagWithOverrides } from "@leadwolf/types";
import {
  Dialog,
  EmptyState,
  FieldGroup,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { useState } from "react";
import { setTenantOverride } from "../api";

export function OverrideDialog({
  flag,
  onClose,
  onChanged,
}: {
  flag: FeatureFlagWithOverrides;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [tenantId, setTenantId] = useState("");
  const [enabled, setEnabled] = useState<"true" | "false">("true");
  const [busy, setBusy] = useState(false);

  async function apply(targetTenant: string, value: boolean | null) {
    setBusy(true);
    try {
      await setTenantOverride(flag.key, { tenant_id: targetTenant, enabled: value });
      toast.success(value === null ? "Override cleared" : "Override set for tenant");
      setTenantId("");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Override change failed");
    } finally {
      setBusy(false);
    }
  }

  const validUuid = /^[0-9a-fA-F-]{36}$/.test(tenantId.trim());

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Overrides — ${flag.key}`}
      description="A per-tenant override wins over the global default for that tenant only."
      maxWidth={520}
      footer={
        <TpButton variant="secondary" onClick={onClose}>
          Done
        </TpButton>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {flag.overrides.length === 0 ? (
            <EmptyState
              title="No overrides"
              description="This flag uses its global default for all tenants."
            />
          ) : (
            flag.overrides.map((o) => (
              <div
                key={o.tenantId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--tp-hairline-2)",
                }}
              >
                <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontSize: 12 }}>
                  {o.tenantId}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusBadge tone={o.enabled ? "success" : "danger"}>
                    {o.enabled ? "Forced on" : "Forced off"}
                  </StatusBadge>
                  <TpButton
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void apply(o.tenantId, null)}
                  >
                    Clear
                  </TpButton>
                </div>
              </div>
            ))
          )}
        </section>

        <section style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <FieldGroup label="Tenant id" htmlFor="ov-tenant" className="tp-ui-grow">
            <TpInput
              id="ov-tenant"
              value={tenantId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(e) => setTenantId(e.currentTarget.value)}
            />
          </FieldGroup>
          <FieldGroup label="Force">
            <TpSelect
              value={enabled}
              onChange={(e) => setEnabled(e.currentTarget.value as "true" | "false")}
            >
              <option value="true">On</option>
              <option value="false">Off</option>
            </TpSelect>
          </FieldGroup>
          <TpButton
            disabled={busy || !validUuid}
            onClick={() => void apply(tenantId.trim(), enabled === "true")}
          >
            Set override
          </TpButton>
        </section>
      </div>
    </Dialog>
  );
}
