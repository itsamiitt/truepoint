// UsageTable - the billing usage feed: one row per reveal, with what it drew from and what it cost.
//
// A zero-credit row is not an error - it is a re-reveal or a non-match, both of which are free. The table
// has to show that rather than hiding the row.
import { UsageTable } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** Four reveals including one free row. */
export const Reveals = () => (
  <Frame>
    <UsageTable reveals={D.W.CREDIT_USAGE.reveals} />
  </Frame>
);

/** Nothing spent yet. */
export const Empty = () => (
  <Frame>
    <UsageTable reveals={[]} />
  </Frame>
);
