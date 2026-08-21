// changelog.ts — a public, dated record of what changed.
//
// It exists for a specific reason: a data product's contract is its value, and a vendor who changes one
// quietly is a vendor you cannot build on. Entries are added when the published contract, the price, or the
// sourcing posture changes — not when marketing copy is edited.
//
// Rendered newest-first regardless of the order here, so an entry can be appended without re-sorting.

import type { ChangelogEntry } from "./types.ts";

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: "2026-08-21",
    title: "Portal published; API contract opened for review",
    body: "First publication of doc.truepoint.in. The credit costs, the plan table, the endpoint contract and the sourcing statement are all public from this point. The endpoints are a published contract rather than a running service — every endpoint page carries its status, and that badge changes here when it changes there.",
  },
];
