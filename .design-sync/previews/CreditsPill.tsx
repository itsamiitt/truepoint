// CreditsPill — the reveal-credit balance, shown in the popup (full) and the panel's brand bar (compact).
//
// Credits are a PURCHASED settlement unit, never something a contribution earns — the pill reports a
// balance, it is not a score. The low-balance tint is the component's only conditional styling.
import { CreditsPill } from "@leadwolf/ui";

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: 16,
  background: "#fff",
  borderRadius: 10,
  border: "1px solid var(--tp-hairline, #f0f0f0)",
};

/** The full pill as the popup renders it. */
export const Balance = () => (
  <div style={row}>
    <CreditsPill credits={248} />
  </div>
);

/** Below the low-balance threshold — the value switches to the warning tone. */
export const LowBalance = () => (
  <div style={row}>
    <CreditsPill credits={7} />
  </div>
);

/** Balance not yet resolved: an em dash, never a fabricated zero. */
export const Unknown = () => (
  <div style={row}>
    <CreditsPill credits={null} />
  </div>
);

/** The compact form the panel's brand bar uses next to the lockup. */
export const Compact = () => (
  <div style={row}>
    <CreditsPill credits={12_480} compact />
    <CreditsPill credits={7} compact />
    <CreditsPill credits={null} compact />
  </div>
);
