// ConflictQueue - CRM field conflicts awaiting a decision: TruePoint's value against the CRM's, per field.
//
// A conflict is not resolved automatically. Which side wins is a human call, because both systems believe
// they are right and the wrong choice silently overwrites a customer's data.
import { ConflictQueue } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const base = { onResolve: async () => {}, onRetry: () => {} };

/** Two conflicts, each showing both candidate values. */
export const Conflicts = () => (
  <Frame>
    <ConflictQueue conflicts={D.W.CRM_CONFLICTS.conflicts} loading={false} error={null} resolving={false} {...base} />
  </Frame>
);

/** A decision in flight. */
export const Resolving = () => (
  <Frame>
    <ConflictQueue conflicts={D.W.CRM_CONFLICTS.conflicts} loading={false} error={null} resolving {...base} />
  </Frame>
);

/** Nothing conflicting - the good state. */
export const Clear = () => (
  <Frame>
    <ConflictQueue conflicts={[]} loading={false} error={null} resolving={false} {...base} />
  </Frame>
);

/** The error branch. */
export const Failed = () => (
  <Frame>
    <ConflictQueue conflicts={null} loading={false} error="The request timed out after 30s" resolving={false} {...base} />
  </Frame>
);
