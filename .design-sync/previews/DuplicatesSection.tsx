// DuplicatesSection - the duplicate-review queue on Data health: candidate pairs the matcher flagged, with
// per-row unmark and a merge review.
//
// `unmarking` is the id of the row whose unmark is in flight, so the busy state lands on that row alone.
import { DuplicatesSection } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const base = {
  onRetry: () => {},
  onUnmark: async () => {},
  onMerged: () => {},
};

/** Two candidate pairs with their match score and the reason the matcher flagged them. */
export const Pairs = () => (
  <Frame>
    <DuplicatesSection pairs={D.W.DUPLICATE_PAIRS} loading={false} error={null} unmarking={null} {...base} />
  </Frame>
);

/** One row mid-unmark - only that row is busy. */
export const Unmarking = () => (
  <Frame>
    <DuplicatesSection
      pairs={D.W.DUPLICATE_PAIRS}
      loading={false}
      error={null}
      unmarking={D.W.DUPLICATE_PAIRS[0].id}
      {...base}
    />
  </Frame>
);

/** Nothing flagged - the good state, which still has to say so. */
export const NoDuplicates = () => (
  <Frame>
    <DuplicatesSection pairs={[]} loading={false} error={null} unmarking={null} {...base} />
  </Frame>
);

/** The error branch. */
export const Failed = () => (
  <Frame>
    <DuplicatesSection
      pairs={null}
      loading={false}
      error="The request timed out after 30s"
      unmarking={null}
      {...base}
    />
  </Frame>
);
