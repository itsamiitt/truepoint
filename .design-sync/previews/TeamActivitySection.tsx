// TeamActivitySection - per-member reveal and credit activity. Members are labelled by a stable PII-free id, not by name.
//
// Takes its data as props, so the states here are genuinely per-story: the loaded render, the loading
// branch, and the error branch the component actually implements.
import { TeamActivitySection } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with the workspace's real numbers. */
export const Loaded = () => (
  <Frame>
    <TeamActivitySection rollup={D.TEAM_ROLLUP} {...D.idle} />
  </Frame>
);

/** Nothing to show yet - the empty branch, which has to say so rather than render an empty frame. */
export const Empty = () => (
  <Frame>
    <TeamActivitySection rollup={null} {...D.idle} />
  </Frame>
);

/** While the request is in flight - the component's own skeleton, not a spinner bolted on top. */
export const Loading = () => (
  <Frame>
    <TeamActivitySection rollup={null} {...D.busy} />
  </Frame>
);

/** The error branch, which states the cause and offers a retry rather than showing nothing. */
export const Failed = () => (
  <Frame>
    <TeamActivitySection rollup={null} {...D.failed} />
  </Frame>
);
