// Action popup (08 §3.3) — brand-first: the TruePoint lockup, a live credit balance, and a jump into the
// side panel. "Cobalt fills, Ink type" — the primary button + all type are Ink; the only accent is the mark's
// apex and the connected check; the credit number is Geist Mono. Token-driven (04 §3); React 19.
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import type { AppState } from "../../shared/messages.ts";
import { CreditsPill } from "../brand/CreditsPill.tsx";
import { Lockup, Mark } from "../brand/Mark.tsx";

const wrap: React.CSSProperties = {
  width: 320,
  boxSizing: "border-box",
  padding: "var(--tp-space-5, 20px)",
  fontFamily: "var(--font-sans, system-ui)",
  color: "var(--tp-ink, #111827)",
  background: "var(--tp-surface, #fff)",
};
const primaryBtn: React.CSSProperties = {
  width: "100%",
  border: 0,
  borderRadius: "var(--radius, 8px)",
  padding: "10px 14px",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  color: "var(--tp-on-fill, #fff)",
  background: "var(--tp-btn, #111827)",
};
const account: React.CSSProperties = {
  fontSize: 13,
  color: "var(--tp-ink-3, #6b7280)",
  marginTop: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

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

// "Connected" as a machine-verified mono tag with the single Cobalt check (brand: verified label pattern).
function ConnectedTag(): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--tp-ink-3, #6b7280)",
      }}
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--tp-cobalt, #2563c9)"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {t("popup.connected")}
    </span>
  );
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
      <div style={{ ...wrap, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
          <Mark size={44} />
        </div>
        <div style={{ fontSize: 22, letterSpacing: "-0.02em", fontWeight: 600, marginTop: 14 }}>
          {t("app.tagline")}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--tp-ink-3, #6b7280)",
            margin: "8px 0 20px",
            lineHeight: 1.5,
          }}
        >
          {t("popup.signedOutHint")}
        </div>
        <button type="button" style={primaryBtn} onClick={() => void send({ type: "AUTH_LOGIN" })}>
          {t("popup.signIn")}
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Lockup markSize={20} wordSize={15} />
        <ConnectedTag />
      </div>
      {state.auth.account ? <div style={account}>{state.auth.account}</div> : null}
      <div style={{ marginTop: 14 }}>
        <CreditsPill credits={state.auth.credits} />
      </div>
      <button
        type="button"
        style={{ ...primaryBtn, marginTop: 16 }}
        onClick={() => void openPanel()}
      >
        {t("popup.openWorkspace")}
      </button>
    </div>
  );
}
