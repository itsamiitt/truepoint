// orgKindCopy.ts — label an organization by what it actually is (plan 33 · A3).
//
// Migration 0108 made `org_kind` first-class on the graph: a school is an organization, not a separate
// subsystem. The UI predates that and says "company" everywhere — so the first university to land in a
// workspace gets a building glyph, a "Firmographics" heading and a "company" empty state, all three wrong.
//
// PURE: a token in, copy out. No React, no fetching — which is what makes it unit-testable and what stops
// three components from each inventing their own wording for the same token.

export type OrgKindToken = "company" | "school" | "nonprofit" | "government" | "other" | null;

interface OrgCopy {
  /** The heading over the firmographic block. */
  attributesTitle: string;
  /** The word for this institution in running copy, lowercase ("this company", "this university"). */
  noun: string;
}

const COPY: Record<Exclude<OrgKindToken, null>, OrgCopy> = {
  company: { attributesTitle: "Firmographics", noun: "company" },
  school: { attributesTitle: "Institution", noun: "school" },
  nonprofit: { attributesTitle: "Organization", noun: "nonprofit" },
  government: { attributesTitle: "Organization", noun: "agency" },
  other: { attributesTitle: "Organization", noun: "organization" },
};

/**
 * Copy for an organization kind.
 *
 * An unresolved account (null) falls back to COMPANY rather than to a neutral "organization": the
 * overwhelming majority of accounts are companies, and hedging every label to stay technically correct for
 * the rare school would make the common case read like a machine wrote it. The moment the bridge resolves,
 * the real kind wins.
 */
export function orgKindCopy(kind: OrgKindToken): OrgCopy {
  return COPY[kind ?? "company"] ?? COPY.company;
}

/** True when this is NOT an ordinary company — the cue for showing the kind explicitly. */
export function isNotableOrgKind(kind: OrgKindToken): boolean {
  return kind !== null && kind !== "company";
}
