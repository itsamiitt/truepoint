// Side panel (08 §3.2) — the tabbed workspace, brand-first. The header carries the TruePoint lockup + the
// live credit balance; the Captured tab reads the local `recent` store and renders all four StateSwitch states
// (loading / empty / error+retry / populated) as brand rows (mono initials + mono outcome label). Token-driven
// (04 §3): "Cobalt fills, Ink type" — the active tab is a soft Cobalt fill, everything else is ink + hairline.
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import { type RecentItem, db } from "../../shared/idb.ts";
import type { AppState } from "../../shared/messages.ts";
import { CreditsPill } from "../brand/CreditsPill.tsx";
import { Lockup } from "../brand/Mark.tsx";

type Tab = "captured" | "reveal" | "lists" | "sequences" | "ai";
type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

const TABS: { id: Tab; labelKey: Parameters<typeof t>[0] }[] = [
  { id: "captured", labelKey: "panel.captured" },
  { id: "reveal", labelKey: "panel.reveal" },
  { id: "lists", labelKey: "panel.lists" },
  { id: "sequences", labelKey: "panel.sequences" },
  { id: "ai", labelKey: "panel.ai" },
];

const shell: React.CSSProperties = {
  fontFamily: "var(--font-sans, system-ui)",
  color: "var(--tp-ink, #111827)",
  background: "var(--tp-surface, #fff)",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
};
const bar: React.CSSProperties = {
  height: 52,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 var(--tp-space-4, 16px)",
  borderBottom: "1px solid var(--tp-hairline-2, #e5e7eb)",
};
const tabsRow: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "8px var(--tp-space-4, 16px)",
  borderBottom: "1px solid var(--tp-hairline, #f0f0f0)",
};
const body: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "var(--tp-space-4, 16px)",
};
const muted: React.CSSProperties = { color: "var(--tp-ink-3, #6b7280)", fontSize: 13 };
const monoOutcome: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--tp-ink-4, #9ca3af)",
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    border: 0,
    background: active ? "var(--tp-cobalt-50, #e9f0fc)" : "transparent",
    color: active ? "var(--tp-cobalt-700, #1e4fa3)" : "var(--tp-ink-3, #6b7280)",
    borderRadius: "var(--tp-radius-sm, 6px)",
    padding: "5px 11px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

/** Two-letter initials for the row avatar (mono, per the Brand-Kit lead rows). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function EmptyState({ title, hint }: { title: string; hint: string }): React.ReactElement {
  return (
    <div style={{ textAlign: "center", padding: "40px 0" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={muted}>{hint}</div>
    </div>
  );
}

function CapturedTab(): React.ReactElement {
  const [load, setLoad] = useState<Load<RecentItem[]>>({ status: "loading" });

  const reload = useCallback(() => {
    setLoad({ status: "loading" });
    db()
      .then((database) => database.getAll("recent"))
      .then((rows) => setLoad({ status: "ready", data: rows }))
      .catch(() => setLoad({ status: "error" }));
  }, []);

  // reload is a stable useCallback([]) — run once on mount.
  useEffect(reload, []);

  if (load.status === "loading") {
    return <div style={muted}>{t("state.loading")}</div>;
  }
  if (load.status === "error") {
    return (
      <div style={{ textAlign: "center", padding: "40px 0" }}>
        <div style={{ marginBottom: 8 }}>{t("panel.errorLoad")}</div>
        <button type="button" style={tabStyle(false)} onClick={reload}>
          {t("panel.retry")}
        </button>
      </div>
    );
  }
  if (load.data.length === 0) {
    return <EmptyState title={t("panel.emptyCaptured")} hint={t("panel.emptyCapturedHint")} />;
  }
  return (
    <div>
      {load.data.map((item) => (
        <div
          key={item.contactId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minHeight: 48,
            padding: "8px 0",
            borderBottom: "1px solid var(--tp-hairline, #f0f0f0)",
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              borderRadius: "50%",
              background: "var(--tp-surface-3, #f4f5f7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--tp-ink-3, #6b7280)",
            }}
          >
            {initials(item.name)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.name}
            </div>
            {item.company ? (
              <div
                style={{
                  ...muted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.company}
              </div>
            ) : null}
          </div>
          <span style={monoOutcome}>{item.outcome}</span>
        </div>
      ))}
    </div>
  );
}

export function Panel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("captured");
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void send({ type: "GET_STATE" }).then(setState);
    return onBroadcast((msg) => {
      if (msg.type === "STATE_CHANGED") {
        setState(msg.state);
      }
    });
  }, []);

  const signedIn = state?.auth.status === "signed_in";

  return (
    <div style={shell}>
      <div style={bar}>
        <Lockup markSize={22} wordSize={16} />
        {signedIn ? <CreditsPill credits={state?.auth.credits ?? null} compact /> : null}
      </div>
      <div style={tabsRow}>
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            style={tabStyle(tab === entry.id)}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>
      <div style={body}>
        {tab === "captured" ? (
          <CapturedTab />
        ) : (
          <EmptyState title={t("panel.emptyCaptured")} hint={t("panel.emptyCapturedHint")} />
        )}
      </div>
    </div>
  );
}
