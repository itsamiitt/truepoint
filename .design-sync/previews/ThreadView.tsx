// ThreadView - one reply thread in the Inbox: the transcript, the done/snooze actions, and a quick reply.
//
// It renders in a fixed-position Drawer, so the card gives it a sized, transform-anchored Stage; an
// auto-height frame clips everything below the header.
//
// One story per state: it takes a threadId and loads the thread itself. `threadId: null` is the closed state,
// which the Inbox uses to show its empty pane instead.
import { ThreadView } from "@leadwolf/ui";
import { Stage } from "./_webPage";

/** A thread open, with the conversation and the reply box. */
export const Open = () => (
  <Stage height={640}>
    <ThreadView threadId="th_01" onClose={() => {}} onChanged={() => {}} />
  </Stage>
);

/** Nothing selected - the drawer stays closed rather than rendering an empty transcript. */
export const NoSelection = () => (
  <Stage height={220}>
    <ThreadView threadId={null} onClose={() => {}} onChanged={() => {}} />
  </Stage>
);
