// MailboxList - the sending identities this workspace can send from.
//
// `available` is the FEATURE GATE, separate from emptiness: sending ships behind a flag, and a workspace
// without it sees the capability named and explained rather than an empty list that looks like a bug.
// `reload` is the retry seam; the list itself never fetches.
import { MailboxList } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const base = { available: true, reload: () => {} };

/** Three connected mailboxes - two OAuth, one SMTP carrying its failure REASON, never its credential. */
export const Loaded = () => (
  <Frame>
    <MailboxList mailboxes={D.W.MAILBOXES.mailboxes} {...base} loading={false} error={null} />
  </Frame>
);

/** Enabled, but nothing connected yet. */
export const Empty = () => (
  <Frame>
    <MailboxList mailboxes={[]} {...base} loading={false} error={null} />
  </Frame>
);

/** The feature gate: sending is not enabled for this workspace, said plainly. */
export const Unavailable = () => (
  <Frame>
    <MailboxList mailboxes={[]} {...base} available={false} loading={false} error={null} />
  </Frame>
);

/** While the request is in flight. */
export const Loading = () => (
  <Frame>
    <MailboxList mailboxes={[]} {...base} loading error={null} />
  </Frame>
);

/** The error branch, which states the cause. */
export const Failed = () => (
  <Frame>
    <MailboxList mailboxes={[]} {...base} loading={false} error="The request timed out after 30s" />
  </Frame>
);
