// Action popup (08 §3.3) — brand-first: the TruePoint lockup, a live credit balance, and a jump into the
// side panel. "Cobalt fills, Ink type" — the primary button + all type are Ink; the only accent is the mark's
// apex and the connected check; the credit number is Geist Mono. Token-driven (04 §3); React 19.
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
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
// NOT panel/primitives' Button, deliberately. That file is the PANEL's atoms — a 320px popup card wants a
// chunkier CTA (10px/14px against the panel's 7px/12px), and reaching across surfaces for it would either
// import the panel's scale into the popup or push the popup's scale into the panel. Both real <button
// type="button">s, and the DS :focus-visible ring reaches them: popup/main.tsx imports brand.css, which
// imports @leadwolf/ui/tokens.css, where the ring is a bare `:focus-visible` selector.
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
        fontSize: 11,
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
  const [query, setQuery] = useState("");

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
      <form
        style={{ marginTop: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          if (!q) return;
          // A quick jump, not an in-popup result list — the popup is quick entry, the app is the workspace.
          void chrome.tabs.create({
            url: `${ENV.appOrigin}/search?q=${encodeURIComponent(q)}`,
          });
          window.close();
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("popup.quickSearch")}
          aria-label={t("popup.quickSearch")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 11px",
            fontSize: 13,
            fontFamily: "inherit",
            color: "var(--tp-ink, #111827)",
            background: "var(--tp-surface, #fff)",
            border: "1px solid var(--tp-hairline-2, #e5e7eb)",
            borderRadius: "var(--radius, 8px)",
          }}
        />
      </form>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 14,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={state.captureEnabled}
          onChange={(e) => {
            void send({ type: "SET_CAPTURE_ENABLED", enabled: e.target.checked }).then(setState);
          }}
        />
        {t("popup.captureLabel")}
      </label>
      {!state.captureEnabled ? (
        <div style={{ fontSize: 12, color: "var(--tp-ink-3, #6b7280)", marginTop: 5 }}>
          {t("popup.capturePausedHint")}
        </div>
      ) : null}
      {state.queueDepth > 0 ? (
        <div style={{ fontSize: 12, color: "var(--tp-ink-3, #6b7280)", marginTop: 5 }}>
          {t("popup.queued", { n: state.queueDepth })}
        </div>
      ) : null}
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
