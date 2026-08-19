// Popup — the toolbar popup: lockup, connection tag, account, credits, and the button into the side panel.
//
// One story. The popup has exactly two whole-surface branches, signed-in and signed-out, and which one it
// renders is decided by the GET_STATE answer from the module-level message-bus stub — shared by every cell
// in a card, so the two cannot be shown side by side without one leaking into the other. The signed-in
// branch is the one worth designing against; the signed-out branch is a centred mark, tagline and one
// button, and it is fully described in the component's own source.
import { Popup } from "@leadwolf/ui";

const frame: React.CSSProperties = {
  width: 340,
  overflow: "hidden",
  border: "1px solid var(--tp-hairline, #f0f0f0)",
  borderRadius: 10,
  background: "#fff",
};

/** Signed in: workspace connected, account shown, 248 credits, one way into the panel. */
export const SignedIn = () => (
  <div style={frame}>
    <Popup />
  </div>
);
