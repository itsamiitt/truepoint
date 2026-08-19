// LineChart - the trend line the Reports and Data health sections draw with.
import { LineChart } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Five weekly points of email-validity percentage. */
export const Trend = () => (
  <Frame>
    <LineChart data={D.LINE_DATA} ariaLabel="Email validity over time" />
  </Frame>
);

/** Two points - the shortest series that is still a line rather than a dot. */
export const TwoPoints = () => (
  <Frame>
    <LineChart data={D.LINE_DATA.slice(-2)} ariaLabel="Email validity over time" />
  </Frame>
);

/** A taller variant, as the full-width Reports section renders it. */
export const Tall = () => (
  <Frame>
    <LineChart data={D.LINE_DATA} height={200} ariaLabel="Email validity over time" />
  </Frame>
);
