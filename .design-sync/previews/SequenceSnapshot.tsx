// SequenceSnapshot - the outreach snapshot on Home: active sequences, enrolled, sent and replied.
//
// Takes its data as props, so the states here are genuinely per-story: the loaded render, the loading
// branch, and the error branch the component actually implements.
import { SequenceSnapshot } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with the workspace's real numbers. */
export const Loaded = () => (
  <Frame>
    <SequenceSnapshot snapshot={D.W.HOME_SUMMARY.sequenceSnapshot} {...D.idle} />
  </Frame>
);

/** Nothing to show yet. The empty branch keys off a ZEROED snapshot, not a null one - null means "not
 *  answered yet", which is the loading state, so passing null here would render the skeleton twice. */
export const Empty = () => (
  <Frame>
    <SequenceSnapshot snapshot={{ activeSequences: 0, enrolled: 0, sent: 0, replied: 0 }} {...D.idle} />
  </Frame>
);

/** While the request is in flight - the component's own skeleton, not a spinner bolted on top. */
export const Loading = () => (
  <Frame>
    <SequenceSnapshot snapshot={null} {...D.busy} />
  </Frame>
);

/** The error branch, which states the cause and offers a retry rather than showing nothing. */
export const Failed = () => (
  <Frame>
    <SequenceSnapshot snapshot={null} {...D.failed} />
  </Frame>
);
