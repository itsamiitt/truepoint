// rowAffordances.ts — the ONE place that says what a Search row may do, by its state (decisions.md 2026-08-25):
//   • a SAVED row (a workspace contact): revealable, selectable for bulk actions, the full overflow menu;
//   • a NOT-SAVED row (a database person): its reveal IS the save gesture — offered for every channel the
//     person carries, when the deployment's Layer-0 channel switch is on; never selectable (bulk actions
//     address contacts by id, and it has none until its reveal saves it); overflow menu = LinkedIn only; and
//     NEVER a manual "add".
// Pure, so "a not-saved row exposes zero add affordances and a reveal control for every channel on file" is a
// unit test rather than a screenshot.
import type { ProspectRow } from "./databaseRows";

export interface RowAffordances {
  /** True for a workspace contact, false for a database person. */
  saved: boolean;
  /** Which reveal buttons the row shows — presence AND (for a database row) the deployment switch. */
  reveal: { email: boolean; phone: boolean };
  /** Whether the row may join a bulk selection. */
  select: boolean;
  /** There is no manual add anywhere on the Search surface — the type says so. */
  add: false;
  /** The overflow menu a row gets. */
  actions: "full" | "linkedin";
}

export function rowAffordances(
  row: ProspectRow,
  opts: { databaseRevealEnabled: boolean },
): RowAffordances {
  const saved = row.databaseSlug === undefined;
  const canReveal = saved || opts.databaseRevealEnabled;
  return {
    saved,
    reveal: { email: row.hasEmail && canReveal, phone: row.hasPhone && canReveal },
    select: saved,
    add: false,
    actions: saved ? "full" : "linkedin",
  };
}
