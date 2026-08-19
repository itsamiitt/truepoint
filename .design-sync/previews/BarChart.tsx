// BarChart - the vertical bar chart the Reports sections draw with.
//
// `max` is a SHARED denominator, passed in rather than derived, so two charts on one page stay comparable
// instead of each normalising to its own tallest bar. `accent` and `muted` mark a bar without changing its
// value - the weekend dip below is muted, the peak is accented.
import { BarChart } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** A week of credit spend, with the weekend muted and the peak accented. */
export const Week = () => (
  <Frame>
    <BarChart data={D.BAR_DATA} max={1_872} ariaLabel="Credits spent per day" />
  </Frame>
);

/** The same data against a larger shared max - every bar shortens together, which is the point of passing it. */
export const SharedScale = () => (
  <Frame>
    <BarChart data={D.BAR_DATA} max={4_000} ariaLabel="Credits spent per day" />
  </Frame>
);

/** All zero: the axis and labels still draw, so the chart reads as "nothing yet" rather than broken. */
export const NoData = () => (
  <Frame>
    <BarChart data={D.BAR_DATA.map((d) => ({ ...d, value: 0, caption: "0 reveals" }))} max={1} ariaLabel="Credits spent per day" />
  </Frame>
);
