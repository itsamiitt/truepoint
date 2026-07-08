// AuthPolicyPage.tsx — the Auth Policy admin section. Read view (this slice) of the PLATFORM-DEFAULT auth policy
// the effective-policy engine applies as the base every org inherits and can only TIGHTEN (strictest-wins, never
// loosen below the platform minimum). Mirrors the retention slice: a StateSwitch over a DataTable, client-fetched
// via the useState loader (the Bearer token is in-memory, so all fetching is client-side). Editing a default
// (PUT /admin/auth/platform-policy, already floor-guarded server-side) is the next slice.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import type { PlatformDefault } from "../api";
import { usePlatformDefaults } from "../hooks/usePlatformDefaults";

const columns: Column<PlatformDefault>[] = [
  {
    key: "key",
    header: "Policy key",
    sortValue: (r) => r.key,
    cell: (r) => (
      <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontWeight: 600 }}>{r.key}</span>
    ),
  },
  {
    key: "value",
    header: "Platform default",
    cell: (r) => (
      <code style={{ fontFamily: "var(--tp-font-mono, monospace)" }}>
        {JSON.stringify(r.value)}
      </code>
    ),
  },
];

export function AuthPolicyPage(): React.JSX.Element {
  const { rows, error, loading, reload } = usePlatformDefaults();
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Auth policy</h1>
        <p style={{ color: "var(--tp-ink-3)", margin: "4px 0 0", maxWidth: 640 }}>
          Platform-wide authentication defaults. Every organization inherits these; an org can only
          <em> tighten</em> a value (strictest-wins) and can never loosen one below the platform
          minimum.
        </p>
      </header>
      <StateSwitch
        loading={loading && rows.length === 0}
        error={error}
        empty={!loading && rows.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            title="No platform defaults set"
            description="No platform-wide auth policy keys are configured yet. Organizations fall back to the built-in security floor."
          />
        }
      >
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} />
      </StateSwitch>
    </main>
  );
}
