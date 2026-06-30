// AnnouncementBanner.tsx — the in-app announcement banner (13a Area 10): renders the active announcements for
// the signed-in tenant at the top of the app shell, with a per-announcement dismiss persisted in localStorage
// so a dismissed banner stays gone across reloads. Non-fatal: if the read fails there is simply no banner.
"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { type ActiveAnnouncement, fetchActiveAnnouncements } from "./api";

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
      ? "var(--tp-danger, #dc2626)"
      : level === "warning"
        ? "var(--tp-warning, #d97706)"
        : "var(--tp-accent, #2563eb)";
  return {
    borderLeft: `3px solid ${accent}`,
    background: "var(--tp-surface-2)",
    color: "var(--tp-ink)",
  };
}

export function AnnouncementBanner() {
  const [items, setItems] = useState<ActiveAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  useEffect(() => {
    let cancelled = false;
    void fetchActiveAnnouncements().then((a) => {
      if (!cancelled) setItems(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
            gap: 12,
            padding: "10px 16px",
            fontSize: 14,
            borderBottom: "1px solid var(--tp-hairline-2)",
            ...toneStyle(a.level),
          }}
        >
          <span>
            <strong>{a.title}</strong> {a.body}
          </span>
          {a.type === "maintenance" ? null : (
            <button
              type="button"
              aria-label="Dismiss announcement"
              onClick={() => dismiss(a.id)}
              style={{
                flex: "0 0 auto",
                border: "none",
                background: "transparent",
                color: "var(--tp-ink-3)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
