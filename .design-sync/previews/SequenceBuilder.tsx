// SequenceBuilder - create a sequence and its steps.
import { SequenceBuilder } from "@leadwolf/ui";
import { Stage } from "./_webPage";

/** Open, on a new sequence. */
export const Open = () => (
  <Stage height={640}>
    <SequenceBuilder open onClose={() => {}} onCreated={() => {}} />
  </Stage>
);

/** Closed - renders nothing rather than a hidden overlay. */
export const Closed = () => (
  <Stage height={180}>
    <SequenceBuilder open={false} onClose={() => {}} onCreated={() => {}} />
  </Stage>
);
