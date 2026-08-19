// SequenceList - the sequences table: each sequence with its step count, enrollment, funnel metrics and
// the pause/activate control.
//
// `pendingId` is the row whose status change is in flight, so the busy state lands on that row alone.
import { SequenceList } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const SEQ = D.W.SEQUENCES.sequences;
const base = {
  onRetry: () => {},
  onSelect: () => {},
  onCreate: () => {},
  onSetStatus: () => {},
};

/** Four sequences across active, paused and draft. */
export const Loaded = () => (
  <Frame>
    <SequenceList sequences={SEQ} loading={false} error={null} pendingId={null} {...base} />
  </Frame>
);

/** One row mid status-change. */
export const Pending = () => (
  <Frame>
    <SequenceList sequences={SEQ} loading={false} error={null} pendingId={SEQ[0].id} {...base} />
  </Frame>
);

/** No sequences yet - the create call to action. */
export const Empty = () => (
  <Frame>
    <SequenceList sequences={[]} loading={false} error={null} pendingId={null} {...base} />
  </Frame>
);

/** The error branch. */
export const Failed = () => (
  <Frame>
    <SequenceList sequences={[]} loading={false} error="The request timed out after 30s" pendingId={null} {...base} />
  </Frame>
);
