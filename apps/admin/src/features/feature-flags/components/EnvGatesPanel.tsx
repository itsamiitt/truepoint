// EnvGatesPanel.tsx — a READ-ONLY view of the deploy-time env master-switches (kill-switches) alongside the
// per-tenant flag table. These booleans are set at deploy and read at process boot, so they are NOT toggleable
// from a web UI by design (you don't disable a kill-switch from a browser); the panel surfaces their STATE so
// staff see the whole gate picture + the dual-gate pairing: a feature is live for a tenant only when its env
// master AND its per-tenant flag are both on. Non-blocking — a load failure hides the panel, never the page.
"use client";

import type { EnvFeatureGate } from "@leadwolf/types";
import { type Column, DataTable, StatusBadge } from "@leadwolf/ui";
import { useEnvGates } from "../hooks/useEnvGates";

export function EnvGatesPanel() {
  const { gates, loading, error } = useEnvGates();

  const columns: Column<EnvFeatureGate>[] = [
    {
      key: "label",
      header: "Feature",
      sortValue: (g) => g.label,
      cell: (g) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{g.label}</span>
          <span style={{ color: "var(--tp-ink-3)", fontSize: 12 }}>{g.description}</span>
        </div>
      ),
    },
    {
      key: "key",
      header: "Env var",
      cell: (g) => <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontSize: 12 }}>{g.key}</span>,
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
          <span style={{ fontSize: 12 }}>{g.flagKey}</span>
        ) : (
          <span style={{ color: "var(--tp-ink-3)" }}>— env only</span>
        ),
    },
  ];

  // Secondary panel: never block the flags page on it. Hide while loading or on error.
  if (loading || error || gates.length === 0) return null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Master switches (deploy-time)</h2>
        <p style={{ color: "var(--tp-ink-3)", fontSize: 13 }}>
          Process-level kill-switches set at deploy and read at boot — shown read-only (they can't be
          toggled from a web UI). A feature is live for a tenant only when its master switch AND its
          per-tenant flag are both on.
        </p>
      </div>
      <DataTable columns={columns} rows={gates} rowKey={(g) => g.key} />
    </section>
  );
}
