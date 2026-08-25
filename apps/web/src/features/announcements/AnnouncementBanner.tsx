// AnnouncementBanner.tsx — the in-app announcement banner (13a Area 10): renders the active announcements for
// the signed-in tenant at the top of the app shell, with a per-announcement dismiss persisted in localStorage
// so a dismissed banner stays gone across reloads. Non-fatal: if the read fails there is simply no banner.
"use client";

import { sharedKeys } from "@/lib/queryKeys";
import { TpIconButton } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { fetchActiveAnnouncements } from "./api";

const DISMISS_KEY = "tp-dismissed-announcements";

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveDismissed(s: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...s]));
  } catch {
    // best-effort; dismissal just won't persist
  }
}

/** Left-accent + subtle tint per severity, using brand tokens. */
function toneStyle(level: string): CSSProperties {
  const accent =
    level === "critical"
      ? "var(--danger)"
      : level === "warning"
        ? "var(--warning)"
        : "var(--tp-cobalt)";
  return {
    borderLeft: `3px solid ${accent}`,
    background: "var(--tp-surface-2)",
    color: "var(--tp-ink)",
  };
}

export function AnnouncementBanner() {
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // A query, not a raw useEffect fetch (perf-audit P3.5): announcements re-fetched on every hard load with
  // no cache. 5 minutes of staleness is fine for a banner; a failed read stays what it always was — no
  // banner (non-fatal, no retry storm).
  const items =
    useQuery({
      queryKey: sharedKeys.announcements(),
      queryFn: fetchActiveAnnouncements,
      staleTime: 5 * 60_000,
      retry: false,
    }).data ?? [];

  // Maintenance notices are non-dismissible — they ignore the per-user dismiss set so a critical system
  // message can't be permanently hidden by a click.
  const visible = items.filter((i) => i.type === "maintenance" || !dismissed.has(i.id));
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  }

  return (
    <div aria-live="polite" style={{ display: "flex", flexDirection: "column" }}>
      {visible.map((a) => (
        <div
          key={a.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--tp-space-3)",
            padding: "10px var(--tp-space-4)", // 10px is off the spacing scale — left as a literal
            fontSize: "var(--tp-text-label)",
            borderBottom: "1px solid var(--tp-hairline-2)",
            ...toneStyle(a.level),
          }}
        >
          <span>
            <strong>{a.title}</strong> {a.body}
          </span>
          {a.type === "maintenance" ? null : (
            // TpIconButton is this control: 32px square, ghost, ink-3 with the DS hover — and a hit
            // target the bare glyph never had.
            <TpIconButton
              label="Dismiss announcement"
              onClick={() => dismiss(a.id)}
              style={{ flex: "0 0 auto", fontSize: "var(--tp-text-title)", lineHeight: 1 }}
            >
              ✕
            </TpIconButton>
          )}
        </div>
      ))}
    </div>
  );
}
