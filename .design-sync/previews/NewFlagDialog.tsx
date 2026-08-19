// NewFlagDialog - create a feature flag. `open` is a real prop here, so both states are genuinely
// per-story: closed, the component renders nothing at all, which is worth showing once.
import { NewFlagDialog } from "@leadwolf/ui";
import { Stage } from "./_appPage";

/** Open, ready for a key and description. */
export const Open = () => (
  <Stage height={480}>
    <NewFlagDialog open onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** Closed - nothing rendered, rather than a hidden overlay sitting in the tree. */
export const Closed = () => (
  <Stage height={160}>
    <NewFlagDialog open={false} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);
