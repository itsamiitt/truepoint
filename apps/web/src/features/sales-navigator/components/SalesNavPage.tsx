// SalesNavPage.tsx — composes the Sales Navigator capture surface (05 §5, M7): the capture form above, the
// workspace's captured links below. The form's onCapture refreshes the list so a save is visible immediately.
// This is the feature's public component (rendered by the thin (shell)/sales-navigator route). HITL only.
"use client";

import { useSalesNavLinks } from "../hooks/useSalesNavLinks";
import { CaptureForm } from "./CaptureForm";
import { LinksTable } from "./LinksTable";

export function SalesNavPage() {
  const { links, error, loading, reload, capture, remove } = useSalesNavLinks();

  return (
    <main className="app-main" style={{ display: "grid", gap: 16 }}>
      <header>
        <h1>Sales Navigator</h1>
        <p style={{ color: "var(--tp-ink-3)", fontSize: 13, marginTop: 4 }}>
          Save links to leads, accounts, and lists you find in Sales Navigator. Assisted capture
          only — TruePoint never automates actions on LinkedIn.
        </p>
      </header>

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
