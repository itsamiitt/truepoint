// EconomicsTrend — the daily revenue / reveals series under the economics rollup.
//
// Unlike its siblings this one takes its data as a prop, so its states are genuinely per-story: a full
// window, a short window, and the empty series a brand-new tenant has.
import { EconomicsTrend } from "@leadwolf/ui";
import { TREND } from "./_adminFixtures";

const card: React.CSSProperties = {
  padding: 20,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

/** Fourteen days, with the weekend dip that makes the series read as real. */
export const TwoWeeks = () => (
  <div style={card}>
    <EconomicsTrend trend={TREND} />
  </div>
);

/** A short window — the shape a tenant has in its first week. */
export const ShortWindow = () => (
  <div style={card}>
    <EconomicsTrend trend={TREND.slice(-4)} />
  </div>
);

/** No data yet: the component has to say so rather than draw an axis around nothing. */
export const NoData = () => (
  <div style={card}>
    <EconomicsTrend trend={[]} />
  </div>
);
