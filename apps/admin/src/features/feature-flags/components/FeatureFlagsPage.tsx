// FeatureFlagsPage.tsx — the platform feature-flags admin screen (13 §3.5, ADR-0011). A DataTable of every
// global flag with an inline global toggle (TpSwitch), per-flag override count, and dialogs to define a new
// flag and to set/clear a per-tenant override. All writes go to the audited /admin/* endpoints (api.ts);
// the customer app role is read-only on these tables. Public slice component (the shell renders it).
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { FeatureFlagWithOverrides } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  TpButton,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { setGlobalFlag } from "../api";
import { useFeatureFlags } from "../hooks/useFeatureFlags";
import { NewFlagDialog } from "./NewFlagDialog";
import { OverrideDialog } from "./OverrideDialog";

export function FeatureFlagsPage() {
  const { flags, error, loading, reload } = useFeatureFlags();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("flags:manage");
  const [creating, setCreating] = useState(false);
  const [overrideFor, setOverrideFor] = useState<FeatureFlagWithOverrides | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function toggleGlobal(flag: FeatureFlagWithOverrides, enabled: boolean) {
    setBusyKey(flag.key);
    try {
      await setGlobalFlag(flag.key, { enabled });
      toast.success(`${flag.key} ${enabled ? "enabled" : "disabled"} globally`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyKey(null);
    }
  }

  const columns: Column<FeatureFlagWithOverrides>[] = [
    {
      key: "key",
      header: "Flag",
      sortValue: (f) => f.key,
      cell: (f) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{f.key}</span>
          {f.description ? (
            <span style={{ color: "var(--tp-ink-3)", fontSize: 12 }}>{f.description}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "global",
      header: "Global",
      align: "center",
      width: 120,
      cell: (f) => (
        <TpSwitch
          checked={f.globalEnabled}
          disabled={busyKey === f.key || !canManage}
          aria-label={`Toggle ${f.key} globally`}
          onChange={(e) => void toggleGlobal(f, e.currentTarget.checked)}
        />
      ),
    },
    {
      key: "default",
      header: "Default",
      align: "center",
      width: 100,
      sortValue: (f) => (f.defaultEnabled ? 1 : 0),
      cell: (f) => (
        <StatusBadge tone={f.defaultEnabled ? "success" : "muted"}>
          {f.defaultEnabled ? "On" : "Off"}
        </StatusBadge>
      ),
    },
    {
      key: "overrides",
      header: "Overrides",
      align: "right",
      width: 160,
      sortValue: (f) => f.overrides.length,
      cell: (f) => (
        <TpButton
          variant="ghost"
          size="sm"
          leftIcon={<Users size={14} />}
          onClick={() => setOverrideFor(f)}
        >
          {f.overrides.length} tenant{f.overrides.length === 1 ? "" : "s"}
        </TpButton>
      ),
    },
  ];

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Feature flags</h1>
          <p style={{ color: "var(--tp-ink-3)", fontSize: 13 }}>
            Global flags with per-tenant overrides. Evaluation: a tenant override wins, else the
            global default. Every change is audited.
          </p>
        </div>
        {canManage ? (
          <TpButton leftIcon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New flag
          </TpButton>
        ) : null}
      </header>

      {loading && flags.length === 0 ? (
        <LoadingState label="Loading feature flags…" />
      ) : error ? (
        <ErrorState detail={error} onRetry={reload} />
      ) : (
        <DataTable
          columns={columns}
          rows={flags}
          rowKey={(f) => f.key}
          empty={
            <EmptyState
              title="No feature flags yet"
              description="Define one to start gating features."
            />
          }
        />
      )}

      <NewFlagDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await reload();
        }}
      />

      {overrideFor ? (
        <OverrideDialog
          flag={overrideFor}
          onClose={() => setOverrideFor(null)}
          onChanged={async () => {
            setOverrideFor(null);
            await reload();
          }}
        />
      ) : null}
    </main>
  );
}
