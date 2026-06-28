// RetentionPage.tsx — the retention surface host (data-management A2 + A5). Owns the page chrome (title + the
// Policies | Runs Tabs) and switches between two sub-views: Policies (the GLOBAL per-class TTL/mode editor,
// A2) and Runs (the cross-tenant SHADOW evidence operators review BEFORE flipping a class to enforce, A5).
// A pure composition shell — each tab renders its own content; this file holds no data state. Mirrors the
// web Data Health Tabs idiom (guarded `tab === "x" ? (...) : null` per tab, no nested ternary). Public slice
// component (the /retention shell route mounts it).
"use client";

import { Tabs } from "@leadwolf/ui";
import { useState } from "react";
import { RetentionPoliciesPage } from "./RetentionPoliciesPage";
import { RetentionRunsPanel } from "./RetentionRunsPanel";

type TabId = "policies" | "runs";

const TABS: { value: TabId; label: string }[] = [
  { value: "policies", label: "Policies" },
  { value: "runs", label: "Runs" },
];

export function RetentionPage() {
  const [tab, setTab] = useState<TabId>("policies");

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Retention</h1>
      </header>

      <Tabs
        items={TABS}
        value={tab}
        onChange={(v) => setTab(v as TabId)}
        aria-label="Retention views"
      />

      {tab === "policies" ? <RetentionPoliciesPage /> : null}
      {tab === "runs" ? <RetentionRunsPanel /> : null}
    </main>
  );
}
