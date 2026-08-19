// Mark — the TruePoint chevron: three stacked strokes, the apex carrying the accent.
//
// The variant axis is what the apex stroke does: `default` picks up the brand accent, `mono` collapses to
// currentColor for single-colour contexts, `reversed` uses the tint that survives a dark surface. Colour
// otherwise inherits, which is why each cell below sets a colour on the wrapper rather than on the mark.
import { Mark } from "@leadwolf/ui";

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 24,
  padding: 20,
  borderRadius: 10,
  border: "1px solid var(--tp-hairline, #f0f0f0)",
  background: "#fff",
};

/** The three variants side by side, at the size the popup uses. */
export const Variants = () => (
  <div style={{ ...row, color: "var(--tp-ink, #111827)" }}>
    <Mark size={44} variant="default" />
    <Mark size={44} variant="mono" />
  </div>
);

/** Reversed, on the dark surface it exists for. */
export const Reversed = () => (
  <div style={{ ...row, background: "#0b1020", color: "#fff", borderColor: "#0b1020" }}>
    <Mark size={44} variant="reversed" />
  </div>
);

/** The size range in use: 20 in the panel bar, 22 in the popup lockup, 44 as the signed-out hero. */
export const Sizes = () => (
  <div style={{ ...row, color: "var(--tp-ink, #111827)" }}>
    <Mark size={20} />
    <Mark size={22} />
    <Mark size={32} />
    <Mark size={44} />
  </div>
);

/** Colour is inherited, not a prop — the mark takes the tone of whatever it sits in. */
export const Inherits = () => (
  <div style={{ ...row, color: "var(--tp-cobalt, #2f5fd0)" }}>
    <Mark size={32} variant="mono" />
    <span style={{ fontSize: 13, color: "var(--tp-ink-3, #6b7280)" }}>
      mono takes the parent’s colour
    </span>
  </div>
);
