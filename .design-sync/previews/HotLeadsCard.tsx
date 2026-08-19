// HotLeadsCard - the five highest-priority contacts on Home, with their score and outreach state. Unrevealed rows stay masked.
//
// Takes its data as props, so the states here are genuinely per-story: the loaded render, the loading
// branch, and the error branch the component actually implements.
import { HotLeadsCard } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with the workspace's real numbers. */
export const Loaded = () => (
  <Frame>
    <HotLeadsCard leads={D.W.HOME_SUMMARY.hotLeads} {...D.idle} />
  </Frame>
);

/** Nothing to show yet - the empty branch, which has to say so rather than render an empty frame. */
export const Empty = () => (
  <Frame>
    <HotLeadsCard leads={[]} {...D.idle} />
  </Frame>
);

/** While the request is in flight - the component's own skeleton, not a spinner bolted on top. */
export const Loading = () => (
  <Frame>
    <HotLeadsCard leads={[]} {...D.busy} />
  </Frame>
);

/** The error branch, which states the cause and offers a retry rather than showing nothing. */
export const Failed = () => (
  <Frame>
    <HotLeadsCard leads={[]} {...D.failed} />
  </Frame>
);
