// RevealCell — the per-row email/phone cell and the whole mask→reveal seam in miniature. Before a reveal
// the workspace holds no PII, so the cell shows the credit cost; after one it shows the value with its
// verification status and a copy action. Reads owned-reveal state from the RevealStore.
import { RevealCell } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, pad } from "./_prospectShell";

const grid: React.CSSProperties = { ...pad, display: "grid", gap: 12, justifyItems: "start" };

/** Not yet revealed: the cost chip is the affordance — 1 credit for an email, 3 for a phone. */
export const Unrevealed = () => (
  <Shell reveal>
    <div style={grid}>
      <RevealCell contact={CONTACTS[2]} field="email" />
      <RevealCell contact={CONTACTS[2]} field="phone" />
    </div>
  </Shell>
);

/** Already owned by the workspace: the real value, its status, and copy — no further charge. Hydrated the
 *  way the grid hydrates its visible rows, so the card shows the value and not just the "Revealed" flag. */
export const Revealed = () => (
  <Shell reveal hydrate={[CONTACTS[0].id]}>
    <div style={grid}>
      <RevealCell contact={CONTACTS[0]} field="email" />
      <RevealCell contact={CONTACTS[0]} field="phone" />
    </div>
  </Shell>
);

/** No email on the record at all — nothing to reveal, so no cost chip is offered. */
export const NoValue = () => (
  <Shell reveal>
    <div style={grid}>
      <RevealCell contact={CONTACTS[9]} field="email" />
      <RevealCell contact={CONTACTS[9]} field="phone" />
    </div>
  </Shell>
);
