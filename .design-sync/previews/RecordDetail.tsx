// RecordDetail — the full contact record: identity, the reveal/contactability block, pipeline stage, tags,
// the score breakdown with its history, custom fields, and the activity timeline. The heavy surface
// QuickViewDrawer hands off to; every section loads from its own endpoint through the fixture router.
import { RecordDetail } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

/** A revealed, well-worked record: real contactability, scores, activity and custom fields present. */
export const Revealed = () => (
  <Shell reveal hydrate={[CONTACTS[0].id]}>
    <Stage height={720}>
      <RecordDetail contact={CONTACTS[0]} onClose={() => {}} onRevealed={() => {}} onTagsChanged={() => {}} />
    </Stage>
  </Shell>
);

/** A record nobody has revealed or worked yet — cost chips instead of values, and empty feeds. */
export const Masked = () => (
  <Shell reveal>
    <Stage height={720}>
      <RecordDetail contact={CONTACTS[7]} onClose={() => {}} onRevealed={() => {}} onTagsChanged={() => {}} />
    </Stage>
  </Shell>
);
