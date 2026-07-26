// QuickViewDrawer — the lightweight row preview (24 §4.2). Deliberately cheap: identity, firmographics and
// the MASKED contactability, with a hand-off to the heavy RecordDetail rather than loading it inline.
//
// It never reads the RevealStore — `maskedEmail(contact)` and a literal "Locked — reveal" are what it
// renders for every row, revealed or not. So the honest variant axis here is how contactable the record
// is, not whether it has been revealed; a "revealed" cell would look identical and imply otherwise.
import { QuickViewDrawer } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

/** A contactable record: masked domain, a locked phone, and a risky-email warning on the status badge. */
export const Contactable = () => (
  <Shell reveal>
    <Stage height={560}>
      <QuickViewDrawer contact={CONTACTS[2]} onClose={() => {}} onOpenFull={() => {}} />
    </Stage>
  </Shell>
);

/** A record with neither email nor phone — 'No email' and an em dash instead of any reveal affordance. */
export const NoContactability = () => (
  <Shell reveal>
    <Stage height={560}>
      <QuickViewDrawer contact={CONTACTS[9]} onClose={() => {}} onOpenFull={() => {}} />
    </Stage>
  </Shell>
);

/** Without the hand-off prop the "Open full record" button is hidden — the drawer stands alone. */
export const NoHandoff = () => (
  <Shell reveal>
    <Stage height={560}>
      <QuickViewDrawer contact={CONTACTS[5]} onClose={() => {}} />
    </Stage>
  </Shell>
);
