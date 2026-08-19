// RecentRevealsCard - the latest reveals and what each one cost. A zero-credit row is a re-reveal or a non-match, which is free.
//
// Takes its data as props, so the states here are genuinely per-story: the loaded render, the loading
// branch, and the error branch the component actually implements.
import { RecentRevealsCard } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with the workspace's real numbers. */
export const Loaded = () => (
  <Frame>
    <RecentRevealsCard reveals={D.W.HOME_SUMMARY.recentReveals} {...D.idle} />
  </Frame>
);

/** Nothing to show yet - the empty branch, which has to say so rather than render an empty frame. */
export const Empty = () => (
  <Frame>
    <RecentRevealsCard reveals={[]} {...D.idle} />
  </Frame>
);

/** While the request is in flight - the component's own skeleton, not a spinner bolted on top. */
export const Loading = () => (
  <Frame>
    <RecentRevealsCard reveals={[]} {...D.busy} />
  </Frame>
);

/** The error branch, which states the cause and offers a retry rather than showing nothing. */
export const Failed = () => (
  <Frame>
    <RecentRevealsCard reveals={[]} {...D.failed} />
  </Frame>
);
