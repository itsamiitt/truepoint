// RetentionPage.tsx — the retention surface host (data-management A2 + A5). Owns the page chrome (title + the
// Policies | Runs Tabs) and switches between two sub-views: Policies (the GLOBAL per-class TTL/mode editor,
// A2) and Runs (the cross-tenant SHADOW evidence operators review BEFORE flipping a class to enforce, A5).
// A pure composition shell — each tab renders its own content; this file holds no data state. Mirrors the
// web Data Health Tabs idiom (guarded `tab === "x" ? (...) : null` per tab, no nested ternary). Public slice
// component (the /retention shell route mounts it).
"use client";

import { PageContainer, PageHeader, Tabs } from "@leadwolf/ui";
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
    // PageContainer + PageHeader, not a hand-rolled <main>: AppShellFrame already renders the page's <main>,
    // so this one was a second, nested one — and its 20px title matched no other destination in the console.
    // This is the retention surface's ONE container; the two tab bodies render inside it (nesting a second
    // PageContainer there would cap the width twice and double the page padding).
    <PageContainer width="fluid">
      <PageHeader title="Retention" />

      <Tabs
        items={TABS}
        value={tab}
        onChange={(v) => setTab(v as TabId)}
        aria-label="Retention views"
      />

      {tab === "policies" ? <RetentionPoliciesPage /> : null}
      {tab === "runs" ? <RetentionRunsPanel /> : null}
    </PageContainer>
  );
}
