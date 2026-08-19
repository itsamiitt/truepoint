// AddSendingDomainForm - add a domain to send from. Verification is a separate step: adding the domain
// only records the intent, the DNS records still have to pass.
import { AddSendingDomainForm } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** The form at rest. */
export const Resting = () => (
  <Frame>
    <AddSendingDomainForm onAdded={() => {}} />
  </Frame>
);
