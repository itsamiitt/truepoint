// RevealDialog — the single-record spend confirmation. Never reveal without showing the cost first: the
// dialog states what is being unlocked, what it costs, and the balance it comes out of.
import { RevealDialog } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

/** Unlocking an email — the cheapest reveal at 1 credit. */
export const Email = () => (
  <Shell reveal>
    <Stage height={440}>
      <RevealDialog contact={CONTACTS[2]} revealType="email" open onClose={() => {}} onRevealed={() => {}} />
    </Stage>
  </Shell>
);

/** Unlocking a phone — 3 credits, the same confirmation shape at a different price. */
export const Phone = () => (
  <Shell reveal>
    <Stage height={440}>
      <RevealDialog contact={CONTACTS[5]} revealType="phone" open onClose={() => {}} onRevealed={() => {}} />
    </Stage>
  </Shell>
);
