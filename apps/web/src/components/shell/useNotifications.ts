// useNotifications.ts — client-DERIVED notifications for the top-bar bell (11 §3). There is NO notifications
// backend; this hook fetches the Home summary + the live credit balance via fetchWithAuth and derives a
// small, honest list (low credits, recent imports, sequence replies). Nothing is invented — every item maps
// to a real number already exposed to the signed-in user. Dismissals live in sessionStorage; unread counts
// only items newer than a freshness window. Re-derives on the existing "credits:changed" window event.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { HomeSummary } from "@leadwolf/types";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Matches CreditPill's threshold so the bell and the pill agree on what "low" means. */
const LOW_BALANCE = 20;
/** An item counts toward "unread" only if it happened within this window (kept honest, not noisy). */
const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISSED_KEY = "tp_notifications_dismissed";

export type NotificationTone = "warning" | "success" | "muted";

export interface AppNotification {
  /** Stable id used for dismissal + React keys. */
  id: string;
  tone: NotificationTone;
  title: string;
  detail: string;
  href: string;
  /** ISO timestamp the underlying fact occurred (drives freshness/unread); null = always-current state. */
  at: string | null;
}

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // sessionStorage may be unavailable (privacy mode); dismissal just won't persist this session.
  }
}

/** Build the honest list from the summary + a freshly-read balance (balance wins over the summary copy). */
function derive(summary: HomeSummary, balance: number): AppNotification[] {
  const items: AppNotification[] = [];

  if (balance < LOW_BALANCE) {
    items.push({
      id: "low-credits",
      tone: "warning",
      title: "Credits running low",
      detail: `${balance.toLocaleString()} left — top up to keep revealing.`,
      href: "/settings/billing",
      at: null,
    });
  }

  for (const imp of summary.recentImports.slice(0, 3)) {
    items.push({
      id: `import:${imp.sourceName}:${imp.importedAt}`,
      tone: "muted",
      title: "Import finished",
      detail: `${imp.contactCount.toLocaleString()} contacts from ${imp.sourceName}.`,
      href: "/import",
      at: imp.importedAt,
    });
  }

  if (summary.sequenceSnapshot.replied > 0) {
    items.push({
      id: `replies:${summary.sequenceSnapshot.replied}`,
      tone: "success",
      title: "New replies",
      detail: `${summary.sequenceSnapshot.replied.toLocaleString()} replies across your sequences.`,
      href: "/inbox",
      at: null,
    });
  }

  return items;
}

interface NotificationsState {
  items: AppNotification[];
  unreadCount: number;
  dismiss: (id: string) => void;
  loading: boolean;
}

export function useNotifications(): NotificationsState {
  const [derived, setDerived] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set<string>() : readDismissed(),
  );

  const load = useCallback(async () => {
    try {
      const [summaryRes, balanceRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/api/v1/home/summary`),
        fetchWithAuth(`${API_BASE}/api/v1/credits/balance`),
      ]);
      if (!summaryRes.ok) return;
      const summary = (await summaryRes.json()) as HomeSummary;
      const balance = balanceRes.ok
        ? ((await balanceRes.json()) as { balance: number }).balance
        : summary.creditBalance;
      setDerived(derive(summary, balance));
    } catch {
      // Best-effort: the bell stays quiet (empty) rather than surfacing a network blip as a notification.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("credits:changed", onChange);
    return () => window.removeEventListener("credits:changed", onChange);
  }, [load]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissed(next);
      return next;
    });
  }, []);

  const items = useMemo(() => derived.filter((n) => !dismissed.has(n.id)), [derived, dismissed]);

  // Unread = visible items whose underlying fact is fresh (or always-current state like low credits).
  const unreadCount = useMemo(() => {
    const floor = Date.now() - FRESH_WINDOW_MS;
    return items.filter((n) => n.at === null || new Date(n.at).getTime() >= floor).length;
  }, [items]);

  return { items, unreadCount, dismiss, loading };
}
