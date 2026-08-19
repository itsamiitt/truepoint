// FunnelSection - the outreach funnel from new through meeting-booked, with the conversion at each step.
//
// Takes its data as props, so the states here are genuinely per-story: the loaded render, the loading
// branch, and the error branch the component actually implements.
import { FunnelSection } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with the workspace's real numbers. */
export const Loaded = () => (
  <Frame>
    <FunnelSection rollup={D.FUNNEL_ROLLUP} {...D.idle} />
  </Frame>
);

/** Nothing to show yet - the empty branch, which has to say so rather than render an empty frame. */
export const Empty = () => (
  <Frame>
    <FunnelSection rollup={null} {...D.idle} />
  </Frame>
);

/** While the request is in flight - the component's own skeleton, not a spinner bolted on top. */
export const Loading = () => (
  <Frame>
    <FunnelSection rollup={null} {...D.busy} />
  </Frame>
);

/** The error branch, which states the cause and offers a retry rather than showing nothing. */
export const Failed = () => (
  <Frame>
    <FunnelSection rollup={null} {...D.failed} />
  </Frame>
);
