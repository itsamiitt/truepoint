// Action popup (08 §3.3) — auth state, live credits, and a jump into the side panel. Token-driven
// inline styles only (no hardcoded hex/px beyond the token fallbacks; 08 §1 rule 6). React 19.
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import type { AppState } from "../../shared/messages.ts";

const wrap: React.CSSProperties = {
  width: 360,
  boxSizing: "border-box",
  padding: "var(--tp-space-4, 16px)",
  fontFamily: "var(--font-sans, system-ui)",
  color: "var(--tp-ink, #111827)",
  background: "var(--tp-surface, #fff)",
};
const primaryBtn: React.CSSProperties = {
  width: "100%",
  border: 0,
  borderRadius: "var(--radius, 8px)",
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: "var(--tp-on-fill, #fff)",
  background: "var(--tp-btn, #111827)",
};
const pill: React.CSSProperties = {
  fontSize: 11,
  borderRadius: "var(--tp-radius-sm, 6px)",
  padding: "2px 8px",
  color: "var(--success, #16a34a)",
  border: "1px solid var(--tp-hairline-2, #e5e7eb)",
};
const label: React.CSSProperties = { fontSize: 13, color: "var(--tp-ink-3, #6b7280)" };
const value: React.CSSProperties = { fontVariantNumeric: "tabular-nums", fontWeight: 600 };

async function openPanel(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) {
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    }
  } catch {
    void send({ type: "OPEN_PANEL" });
  }
}

export function Popup(): React.ReactElement {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void send({ type: "GET_STATE" }).then(setState);
    return onBroadcast((msg) => {
      if (msg.type === "STATE_CHANGED") {
        setState(msg.state);
      }
    });
  }, []);

  if (!state || state.auth.status === "signed_out") {
    return (
      <div style={wrap}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{t("app.name")}</div>
        <div style={{ ...label, margin: "8px 0 16px" }}>{t("popup.signedOutHint")}</div>
        <button type="button" style={primaryBtn} onClick={() => void send({ type: "AUTH_LOGIN" })}>
          {t("popup.signIn")}
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>{state.auth.account ?? t("app.name")}</span>
        <span style={pill}>{t("popup.connected")}</span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          margin: "16px 0",
          paddingTop: 12,
          borderTop: "1px solid var(--tp-hairline-2, #e5e7eb)",
        }}
      >
        <span style={label}>{t("popup.credits")}</span>
        <span style={value}>{state.auth.credits ?? "—"}</span>
      </div>
      <button type="button" style={primaryBtn} onClick={() => void openPanel()}>
        {t("popup.openWorkspace")}
      </button>
    </div>
  );
}
