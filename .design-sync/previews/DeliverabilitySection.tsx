// DeliverabilitySection - the Reports deliverability panel. It renders its connect call to action when no
// mailbox is connected, because bounce and reply rates are meaningless without one.
import { DeliverabilitySection } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** The section as it appears in Reports. */
export const Section = () => (
  <Frame>
    <DeliverabilitySection onConnect={() => {}} />
  </Frame>
);
