// BulkActionBar — the sticky bar that appears once rows are selected. Two selection modes with different
// safety properties: explicit ids, and the "all N matching" escalation where the bulk ops send the QUERY
// and the server resolves and caps it. Reveal targets are pre-filtered to rows that can actually be revealed.
import { BulkActionBar } from "@leadwolf/ui";
import { CONTACTS, CONTACT_QUERY, TAGS, TOTAL_CONTACTS, selectionOf } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

const selected = CONTACTS.slice(0, 12);
const ids = selected.map((c) => c.id);
const revealable = selected.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id);

/** Explicit-id mode: 12 rows ticked, with the "select all N matching" escalation still on offer. */
export const ExplicitIds = () => (
  <Shell reveal>
    <Stage height={260}>
      <BulkActionBar
        selection={selectionOf(ids)}
        query={CONTACT_QUERY}
        selectedContacts={selected}
        revealableIds={revealable}
        tags={TAGS}
        onRevealed={() => {}}
        onMutated={() => {}}
      />
    </Stage>
  </Shell>
);

/** Escalated to the whole result set — the bar now targets the query, not a list of ids. */
export const AllMatching = () => (
  <Shell reveal>
    <Stage height={260}>
      <BulkActionBar
        selection={selectionOf(ids, { allMatching: true, matchTotal: TOTAL_CONTACTS })}
        query={CONTACT_QUERY}
        selectedContacts={selected}
        revealableIds={revealable}
        tags={TAGS}
        onRevealed={() => {}}
        onMutated={() => {}}
      />
    </Stage>
  </Shell>
);

/** A surface whose rows aren't backed by the workspace search query (a list's members) hides the
 *  escalation, so it can never resolve to the whole workspace instead of the current set. */
export const NoEscalation = () => (
  <Shell reveal>
    <Stage height={260}>
      <BulkActionBar
        selection={selectionOf(ids)}
        query={CONTACT_QUERY}
        selectedContacts={selected}
        revealableIds={revealable}
        tags={TAGS}
        hideSelectAllMatching
        onRevealed={() => {}}
        onMutated={() => {}}
      />
    </Stage>
  </Shell>
);
