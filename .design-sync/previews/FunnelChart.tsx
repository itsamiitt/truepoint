// FunnelChart - the outreach funnel as horizontal bars, each stage sized against the widest one and
// labelled with its conversion from the step above.
//
// `max` is a SHARED denominator, passed in rather than derived, so two charts on the same page stay
// comparable instead of each normalising to its own tallest bar.
import { FunnelChart } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** The full funnel: 48,120 new down to 38 meetings booked. */
export const Stages = () => (
  <Frame>
    <FunnelChart data={D.FUNNEL_DATA} max={48_120} ariaLabel="Outreach funnel" />
  </Frame>
);

/** A short funnel - the same component with two stages, which is what a new workspace has. */
export const TwoStages = () => (
  <Frame>
    <FunnelChart data={D.FUNNEL_DATA.slice(0, 2)} max={48_120} ariaLabel="Outreach funnel" />
  </Frame>
);

/** Nothing measured yet: every stage at zero still has to draw its labels, not an empty box. */
export const NoData = () => (
  <Frame>
    <FunnelChart
      data={D.FUNNEL_DATA.map((d) => ({ ...d, count: 0, conversionPct: 0 }))}
      max={1}
      ariaLabel="Outreach funnel"
    />
  </Frame>
);
