// CreditUsageSection - the Reports credit section: the balance, the last-7-day spend, and the daily
// breakdown by reveal type.
import { CreditUsageSection } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Loaded, with a week of real spend. */
export const Loaded = () => (
  <Frame>
    <CreditUsageSection balance={12_480} rollup={D.CREDIT_ROLLUP} loading={false} error={null} onRetry={() => {}} />
  </Frame>
);

/** A workspace that has not spent anything yet - `hasSpend: false` is its own state, not an empty chart. */
export const NoSpend = () => (
  <Frame>
    <CreditUsageSection
      balance={250}
      rollup={{ ...D.CREDIT_ROLLUP, revealsLast7: 0, creditsLast7: 0, maxCredits: 0, hasSpend: false, days: D.CREDIT_ROLLUP.days.map((d) => ({ ...d, reveals: 0, credits: 0 })), byType: [] }}
      loading={false}
      error={null}
      onRetry={() => {}}
    />
  </Frame>
);

/** Loading. */
export const Loading = () => (
  <Frame>
    <CreditUsageSection balance={null} rollup={null} loading error={null} onRetry={() => {}} />
  </Frame>
);

/** The error branch. */
export const Failed = () => (
  <Frame>
    <CreditUsageSection balance={null} rollup={null} loading={false} error="The request timed out after 30s" onRetry={() => {}} />
  </Frame>
);
