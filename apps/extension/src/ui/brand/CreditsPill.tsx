// CreditsPill — the live credit balance, brand-styled: Geist Mono, tabular numerals, Ink type (no Cobalt —
// the accent is a fill, never a number), with a warning tint + hint when the balance runs low. Shared by the
// popup (full card) and the panel header (compact). Value comes from AuthState.credits (the SW CreditsStore).
import { t } from "../../i18n/index.ts";

const LOW_BALANCE = 20;

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  // "CREDITS" is a LABEL, not decoration — --tp-ink-4 is 2.54:1 and fails AA at any size, let alone 11px.
  color: "var(--tp-ink-3, #6b7280)",
};

export function CreditsPill({
  credits,
  compact = false,
}: {
  credits: number | null;
  compact?: boolean;
}): React.ReactElement {
  const low = typeof credits === "number" && credits <= LOW_BALANCE;
  // --warning-700, not --warning: this is the balance NUMBER and the hint under it — text, not a fill.
  // --warning is 3.19:1 on white, below the 4.5:1 floor; the -700 half is 5.02:1 and exists for this.
  const valueColor = low ? "var(--warning-700, #b45309)" : "var(--tp-ink, #111827)";
  const value = typeof credits === "number" ? credits.toLocaleString() : "—";

  if (compact) {
    return (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        title={t("popup.credits")}
      >
        <span style={monoLabel}>{t("popup.credits")}</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: valueColor,
          }}
        >
          {value}
        </span>
      </span>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 14px",
        borderRadius: "var(--tp-radius-card, 14px)",
        border: "1px solid var(--tp-hairline-2, #e5e7eb)",
        background: "var(--tp-surface-2, #f9fafb)",
      }}
    >
      <div>
        <div style={monoLabel}>{t("popup.credits")}</div>
        {low ? (
          <div style={{ ...monoLabel, color: "var(--warning-700, #b45309)", marginTop: 4 }}>
            {t("popup.lowBalance")}
          </div>
        ) : null}
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 20,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: valueColor,
        }}
      >
        {value}
      </span>
    </div>
  );
}
