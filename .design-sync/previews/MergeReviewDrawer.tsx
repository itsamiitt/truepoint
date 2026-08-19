// MergeReviewDrawer - the side-by-side merge review for one duplicate pair. `pair: null` closes it.
//
// Merging is destructive and irreversible, which is why it is a review surface rather than a row action.
import { MergeReviewDrawer } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

/** Reviewing the highest-scoring pair. */
export const Reviewing = () => (
  <Stage height={640}>
    <MergeReviewDrawer
      pair={D.W.DUPLICATE_PAIRS[0]}
      onClose={() => {}}
      onMerged={() => {}}
      onNotEnabled={() => {}}
    />
  </Stage>
);

/** `pair: null` - the drawer renders nothing rather than an empty panel. */
export const Closed = () => (
  <Stage height={200}>
    <MergeReviewDrawer pair={null} onClose={() => {}} onMerged={() => {}} onNotEnabled={() => {}} />
  </Stage>
);
