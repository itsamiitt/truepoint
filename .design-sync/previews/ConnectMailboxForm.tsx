// ConnectMailboxForm - connect the identity a workspace sends from.
//
// The provider choice is the whole shape of this form: Google and Microsoft go through the OAuth REDIRECT
// (the form posts to /connect/start and hands the browser to the consent screen), so NO password is ever
// entered here - which is why the resting form shows no credential field at all. SMTP adds a password field
// and the sending-domain select; SES uses the platform identity.
//
// One story: the provider is local state, so a card cannot render the SMTP branch without driving the
// select, and a second cell on the same default would measure identical to this one.
import { ConnectMailboxForm } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** The form at rest, on its Google default - consent-redirect, no credential field. */
export const Resting = () => (
  <Frame>
    <ConnectMailboxForm domains={D.W.SENDING_DOMAINS.domains} onConnected={() => {}} />
  </Frame>
);
