// BrandLockup — the TruePoint lockup used at the top of every auth surface: the chevron mark (cobalt apex
// stroke, ink below) beside the wordmark, where True is Regular 400 and Point is ExtraBold 800.
//
// Inline SVG, no binary asset, no props — the lockup is fixed by the brand. Its colour comes from
// --tp-cobalt and --tp-ink, so the cells below place it on the surfaces it actually appears on.
import { BrandLockup } from "@leadwolf/ui";

const card: React.CSSProperties = {
  padding: 24,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

/** On the auth card surface, at the size every screen renders it. */
export const OnCard = () => (
  <div style={card}>
    <BrandLockup />
  </div>
);

/** On the page ground the account surface uses. */
export const OnCanvas = () => (
  <div style={{ ...card, background: "var(--tp-canvas, #f7f8fa)" }}>
    <BrandLockup />
  </div>
);
