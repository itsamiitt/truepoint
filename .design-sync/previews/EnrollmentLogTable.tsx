// EnrollmentLogTable - the enrollment log for one sequence: where each contact is in the steps, what
// happened last, and the per-row send action.
//
// This one does NOT take the usual {loading, error, onRetry} trio. It takes the entries plus the send state
// the parent owns: `sendingId` (the row currently in flight) and `sendFailures` (a per-row failure map).
// A missing `sendFailures` is not an empty state - the component indexes it directly and throws.
import { EnrollmentLogTable } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const ENTRIES = D.W.ENROLLMENTS.entries;

/** The log at rest: three contacts across three steps, one replied and one bounced. */
export const Loaded = () => (
  <Frame>
    <EnrollmentLogTable entries={ENTRIES} sendingId={null} sendFailures={{}} onSend={() => {}} />
  </Frame>
);

/** One row mid-send - the action is busy on that row only, and the rest stay actionable. */
export const Sending = () => (
  <Frame>
    <EnrollmentLogTable
      entries={ENTRIES}
      sendingId={ENTRIES[0].id}
      sendFailures={{}}
      onSend={() => {}}
    />
  </Frame>
);

/** A send that failed: the failure is reported against its own row, not as a page-level banner. */
export const SendFailed = () => (
  <Frame>
    <EnrollmentLogTable
      entries={ENTRIES}
      sendingId={null}
      sendFailures={{
        [ENTRIES[2].id]: { message: "Mailbox quota reached - retry after 09:00 UTC", code: "quota_exceeded" },
      }}
      onSend={() => {}}
    />
  </Frame>
);

/** Nobody enrolled yet. */
export const Empty = () => (
  <Frame>
    <EnrollmentLogTable entries={[]} sendingId={null} sendFailures={{}} onSend={() => {}} />
  </Frame>
);
