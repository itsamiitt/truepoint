// SendingDomainList - the sending domains and their SPF / DKIM / DMARC state, with per-domain verify.
//
// `available` is the feature gate: when sending is not enabled the list still renders, disabled, rather
// than vanishing - so the capability stays discoverable.
import { SendingDomainList } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const DOMAINS = D.W.SENDING_DOMAINS.domains;
const base = { reload: () => {}, verify: async () => {}, verifyingId: null, actionError: null };

/** Three domains across the status vocabulary: verified, verifying, failed. Only a verified domain
 *  can send - that is the whole point of the list. */
export const Domains = () => (
  <Frame>
    <SendingDomainList domains={DOMAINS} available loading={false} error={null} {...base} />
  </Frame>
);

/** A verify in flight on the domain that is still verifying. */
export const Verifying = () => (
  <Frame>
    <SendingDomainList domains={DOMAINS} available loading={false} error={null} {...base} verifyingId={DOMAINS[1].id} />
  </Frame>
);

/** A verify that failed - reported against the action, not as a page banner. */
export const ActionFailed = () => (
  <Frame>
    <SendingDomainList
      domains={DOMAINS}
      available
      loading={false}
      error={null}
      {...base}
      actionError="DNS lookup found no DKIM record for mail.northwind.example"
    />
  </Frame>
);

/** Sending not enabled for this workspace. */
export const Unavailable = () => (
  <Frame>
    <SendingDomainList domains={[]} available={false} loading={false} error={null} {...base} />
  </Frame>
);
