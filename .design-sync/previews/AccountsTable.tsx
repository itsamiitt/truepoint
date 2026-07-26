// AccountsTable — the company-level results grid under the Prospect surface's "Accounts" scope
// (24, ADR-0035). Firmographic columns only; accounts carry no PII, so there is no mask/reveal seam here.
import { AccountsTable } from "@leadwolf/ui";
import { ACCOUNTS } from "../prospect/fixtures";

/** The populated grid — the state a user spends nearly all their time in. */
export const Results = () => (
  <AccountsTable accounts={ACCOUNTS} loading={false} onOpen={() => {}} />
);

/** First paint, before the account-search response lands. */
export const Loading = () => <AccountsTable accounts={[]} loading onOpen={() => {}} />;

/** A filter set that matches nothing — the grid's own empty treatment, not a page-level one. */
export const NoMatches = () => (
  <AccountsTable accounts={[]} loading={false} onOpen={() => {}} />
);
