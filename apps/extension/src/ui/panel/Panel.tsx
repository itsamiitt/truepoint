// Side panel (08 §3.2) — the tabbed workspace. The Captured tab reads the local `recent` store and
// renders all four StateSwitch states (loading skeleton / empty / error+retry / populated). Token-driven.
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { type RecentItem, db } from "../../shared/idb.ts";

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
  height: 44,
  display: "flex",
  alignItems: "center",
  padding: "0 var(--tp-space-4, 16px)",
  borderBottom: "1px solid var(--tp-hairline-2, #e5e7eb)",
  fontWeight: 600,
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

function tabStyle(active: boolean): React.CSSProperties {
  return {
    border: 0,
    background: active ? "var(--tp-cobalt-50, #e9f0fc)" : "transparent",
    color: active ? "var(--tp-cobalt-700, #1e4fa3)" : "var(--tp-ink-3, #6b7280)",
    borderRadius: "var(--tp-radius-sm, 6px)",
    padding: "4px 10px",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  };
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
            justifyContent: "space-between",
            alignItems: "center",
            minHeight: 44,
            borderBottom: "1px solid var(--tp-hairline, #f0f0f0)",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{item.name}</div>
            {item.company ? <div style={muted}>{item.company}</div> : null}
          </div>
          <span style={muted}>{item.outcome}</span>
        </div>
      ))}
    </div>
  );
}

export function Panel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("captured");

  return (
    <div style={shell}>
      <div style={bar}>{t("app.name")}</div>
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
