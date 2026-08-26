// EnvGatesPanel.tsx — a READ-ONLY view of the deploy-time env master-switches (kill-switches) alongside the
// per-tenant flag table. These booleans are set at deploy and read at process boot, so they are NOT toggleable
// from a web UI by design (you don't disable a kill-switch from a browser); the panel surfaces their STATE so
// staff see the whole gate picture + the dual-gate pairing: a feature is live for a tenant only when its env
// master AND its per-tenant flag are both on.
//
// NON-BLOCKING IS NOT THE SAME AS SILENT. This used to open with
// `if (loading || error || gates.length === 0) return null;`, which does keep the flags page alive — and also
// makes a failed fetch indistinguishable from "there are no master switches", on the ONE surface whose job is
// to tell staff which kill-switches are armed. A staff member reading a blank space concludes the gates are
// clear; the truth may be that the request 500'd. The panel now renders its own states through the State Kit:
// the page above it never blocks, and a failure says so and offers a retry.
"use client";

import type { EnvFeatureGate } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TableSkeleton,
} from "@leadwolf/ui";
import { useEnvGates } from "../hooks/useEnvGates";

export function EnvGatesPanel() {
  const { gates, loading, error, reload } = useEnvGates();

  const columns: Column<EnvFeatureGate>[] = [
    {
      key: "label",
      header: "Feature",
      sortValue: (g) => g.label,
      cell: (g) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{g.label}</span>
          <span style={{ color: "var(--tp-ink-3)", fontSize: "var(--tp-text-caption)" }}>
            {g.description}
          </span>
        </div>
      ),
    },
    {
      key: "key",
      header: "Env var",
      cell: (g) => (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--tp-text-caption)" }}>
          {g.key}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      align: "center",
      width: 90,
      sortValue: (g) => (g.enabled ? 1 : 0),
      cell: (g) => (
        <StatusBadge tone={g.enabled ? "success" : "muted"}>{g.enabled ? "On" : "Off"}</StatusBadge>
      ),
    },
    {
      key: "flagKey",
      header: "Per-tenant flag",
      cell: (g) =>
        g.flagKey ? (
          <span style={{ fontSize: "var(--tp-text-caption)" }}>{g.flagKey}</span>
        ) : (
          <span style={{ color: "var(--tp-ink-3)" }}>— env only</span>
        ),
    },
  ];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-2)" }}>
      <div>
        <h2 style={{ fontSize: "var(--tp-text-lg)", fontWeight: 600 }}>
          Master switches (deploy-time)
        </h2>
        <p style={{ color: "var(--tp-ink-3)", fontSize: "var(--tp-text-body)" }}>
          Process-level kill-switches set at deploy and read at boot — shown read-only (they can't
          be toggled from a web UI). A feature is live for a tenant only when its master switch AND
          its per-tenant flag are both on.
        </p>
      </div>
      <StateSwitch
        loading={loading}
        error={error}
        empty={gates.length === 0}
        onRetry={() => void reload()}
        skeleton={
          <TableSkeleton rows={4} columns={[14, 10, 3, 8]} label="Loading master switches" />
        }
        emptyState={
          <EmptyState
            title="No master switches reported"
            description="This deployment exposes no env-level feature gates."
          />
        }
      >
        <DataTable columns={columns} rows={gates} rowKey={(g) => g.key} />
      </StateSwitch>
    </section>
  );
}
