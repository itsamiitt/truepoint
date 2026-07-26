// RowActions — the per-row overflow menu. The Email item is gated until the row is revealed, so the menu
// itself carries part of the mask seam. Its open state is internal, reached through the trigger — so the
// cell that matters forces it open the way NOTES.md's DropdownMenu pattern prescribes.
import { RowActions } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, Stage, useOpenMenu } from "./_prospectShell";

// The trigger is the last column of a grid row, and the menu is right-aligned to it — so it has to sit at
// the right edge or the panel opens into the stage's clipped left margin.
const row: React.CSSProperties = { display: "flex", justifyContent: "flex-end", padding: 16 };

/** Open on a revealed row that has a LinkedIn URL — the full item set. */
export const Open = () => {
  const ref = useOpenMenu<HTMLDivElement>();
  return (
    <Shell reveal>
      <Stage height={420}>
        <div ref={ref} style={row}>
          <RowActions
            contact={CONTACTS[0]}
            onAddToList={() => {}}
            onTag={() => {}}
            onChangeStatus={() => {}}
            onOpenLinkedin={() => {}}
          />
        </div>
      </Stage>
    </Shell>
  );
};

/** Open on an unrevealed row with no LinkedIn hand-off — the gated items are absent, not disabled. */
export const Gated = () => {
  const ref = useOpenMenu<HTMLDivElement>();
  return (
    <Shell reveal>
      <Stage height={420}>
        <div ref={ref} style={row}>
          <RowActions contact={CONTACTS[7]} onAddToList={() => {}} onTag={() => {}} onChangeStatus={() => {}} />
        </div>
      </Stage>
    </Shell>
  );
};

/** The closed trigger as it sits in a grid row. */
export const Trigger = () => (
  <Shell reveal>
    <div style={row}>
      <RowActions contact={CONTACTS[0]} onAddToList={() => {}} onTag={() => {}} onChangeStatus={() => {}} />
    </div>
  </Shell>
);
