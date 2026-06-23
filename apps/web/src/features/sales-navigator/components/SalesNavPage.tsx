// SalesNavPage.tsx — composes the Sales Navigator capture surface (05 §5, M7): the capture form above, the
// workspace's captured links below. The form's onCapture refreshes the list so a save is visible immediately.
// This is the feature's public component (rendered by the thin (shell)/sales-navigator route). HITL only.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { useSalesNavLinks } from "../hooks/useSalesNavLinks";
import { CaptureForm } from "./CaptureForm";
import { LinksTable } from "./LinksTable";

export function SalesNavPage() {
  const { links, error, loading, reload, capture, remove } = useSalesNavLinks();

  return (
    <main className="app-main" style={{ display: "grid", gap: "var(--tp-space-4)" }}>
      <PageHeader
        title="Sales Navigator"
        subtitle={
          "Save links to leads, accounts, and lists you find in Sales Navigator. Assisted capture only — TruePoint never automates actions on LinkedIn."
        }
      />

      <CaptureForm onCapture={capture} />

      <LinksTable
        links={links}
        loading={loading}
        error={error}
        onReload={() => void reload()}
        onDelete={remove}
      />
    </main>
  );
}
