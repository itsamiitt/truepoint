// DistributionChart - a single stacked bar showing how a total splits across statuses, each segment
// carrying a StatusBadge tone so the judgement reads without the legend.
import { DistributionChart } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** The email-status split across the workspace: valid, catch-all, unverified, risky, invalid. */
export const EmailStatus = () => (
  <Frame>
    <DistributionChart segments={D.DISTRIBUTION} ariaLabel="Email status distribution" />
  </Frame>
);

/** A healthy workspace - almost entirely valid, which is what the bar looks like when it is working. */
export const MostlyValid = () => (
  <Frame>
    <DistributionChart
      segments={[
        { key: "valid", label: "Valid", value: 46_800, tone: "success" },
        { key: "risky", label: "Risky", value: 820, tone: "warning" },
        { key: "invalid", label: "Invalid", value: 500, tone: "danger" },
      ]}
      ariaLabel="Email status distribution"
    />
  </Frame>
);

/** Two segments only, to show the component does not depend on a full palette. */
export const TwoSegments = () => (
  <Frame>
    <DistributionChart
      segments={[
        { key: "verified", label: "Verified", value: 32_722, tone: "success" },
        { key: "stale", label: "Stale", value: 15_398, tone: "muted" },
      ]}
      ariaLabel="Freshness distribution"
    />
  </Frame>
);
