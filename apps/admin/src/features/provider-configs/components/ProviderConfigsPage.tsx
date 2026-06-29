// ProviderConfigsPage.tsx — the enrichment-provider config admin screen (13 §3.6, ADR-0011). A DataTable
// of providers with an enable/disable switch, a MASKED key indicator (never the secret), rate-limit, and a
// monthly cost budget with month-to-date spend + health. Writes go to the audited /admin/provider-configs
// endpoints. NO plaintext secrets ever reach this screen. Public slice component.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  type StatusTone,
  TpButton,
  TpInput,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { setProviderBudget, setProviderEnabled } from "../api";
import { useProviderConfigs } from "../hooks/useProviderConfigs";
import type { ProviderConfigView } from "../types";

const HEALTH_TONE: Record<ProviderConfigView["health"], StatusTone> = {
  healthy: "success",
  degraded: "warning",
  down: "danger",
  unknown: "muted",
};

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export function ProviderConfigsPage() {
  const { providers, error, unavailable, loading, reload } = useProviderConfigs();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("providers:manage");
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(p: ProviderConfigView, enabled: boolean) {
    setBusy(p.provider);
    try {
      await setProviderEnabled(p.provider, enabled);
      toast.success(`${p.label} ${enabled ? "enabled" : "disabled"}`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveBudget(p: ProviderConfigView, value: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Enter a non-negative whole-dollar budget");
      return;
    }
    setBusy(p.provider);
    try {
      await setProviderBudget(p.provider, parsed * 100);
      toast.success(`${p.label} budget updated`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Budget update failed");
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<ProviderConfigView>[] = [
    {
      key: "provider",
      header: "Provider",
      sortValue: (p) => p.label,
      cell: (p) => <span style={{ fontWeight: 600 }}>{p.label}</span>,
    },
    {
      key: "enabled",
      header: "Enabled",
      align: "center",
      width: 100,
      cell: (p) => (
        <TpSwitch
          checked={p.enabled}
          disabled={busy === p.provider || !canManage}
          aria-label={`Toggle ${p.label}`}
          onChange={(e) => void toggle(p, e.currentTarget.checked)}
        />
      ),
    },
    {
      key: "key",
      header: "API key",
      width: 140,
      cell: (p) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <KeyRound size={13} aria-hidden />
          <span style={{ fontFamily: "var(--tp-font-mono, monospace)" }}>
            {p.keyHint ?? "not set"}
          </span>
        </span>
      ),
    },
    {
      key: "rate",
      header: "Rate/min",
      align: "right",
      width: 100,
      sortValue: (p) => p.rateLimitPerMin ?? 0,
      cell: (p) => (p.rateLimitPerMin == null ? "∞" : p.rateLimitPerMin.toLocaleString()),
    },
    {
      key: "budget",
      header: "Monthly budget ($)",
      width: 200,
      cell: (p) => (
        <BudgetCell provider={p} disabled={busy === p.provider || !canManage} onSave={saveBudget} />
      ),
    },
    {
      key: "spend",
      header: "MTD spend",
      align: "right",
      width: 110,
      sortValue: (p) => p.monthToDateCents ?? 0,
      cell: (p) => dollars(p.monthToDateCents),
    },
    {
      key: "health",
      header: "Health",
      align: "center",
      width: 110,
      cell: (p) => <StatusBadge tone={HEALTH_TONE[p.health]}>{p.health}</StatusBadge>,
    },
  ];

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Data providers</h1>
        <p style={{ color: "var(--tp-ink-3)", fontSize: 13 }}>
          Manage enrichment providers — enable/disable, rate limits and cost budgets. API keys are
          stored encrypted and shown only as a masked hint; secrets never reach this screen.
        </p>
      </header>

      {loading && providers.length === 0 ? (
        <LoadingState label="Loading providers…" />
      ) : unavailable ? (
        <EmptyState
          title="Provider configuration not available yet"
          description="The admin provider-config API is part of the broader admin track. This screen will populate once those endpoints are mounted."
          action={
            <TpButton variant="secondary" size="sm" onClick={reload}>
              Retry
            </TpButton>
          }
        />
      ) : error ? (
        <ErrorState detail={error} onRetry={reload} />
      ) : (
        <DataTable
          columns={columns}
          rows={providers}
          rowKey={(p) => p.provider}
          empty={<EmptyState title="No providers configured" />}
        />
      )}
    </main>
  );
}

function BudgetCell({
  provider,
  disabled,
  onSave,
}: {
  provider: ProviderConfigView;
  disabled: boolean;
  onSave: (p: ProviderConfigView, value: string) => void | Promise<void>;
}) {
  const initial =
    provider.monthlyBudgetCents == null ? "" : String(provider.monthlyBudgetCents / 100);
  const [value, setValue] = useState(initial);
  const dirty = value !== initial;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <TpInput
        type="number"
        min={0}
        value={value}
        placeholder="unset"
        disabled={disabled}
        onChange={(e) => setValue(e.currentTarget.value)}
        style={{ width: 100 }}
      />
      <TpButton
        variant="ghost"
        size="sm"
        disabled={disabled || !dirty}
        onClick={() => void onSave(provider, value)}
      >
        Save
      </TpButton>
    </div>
  );
}
