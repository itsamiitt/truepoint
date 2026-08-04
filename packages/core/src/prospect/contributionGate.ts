// contributionGate.ts — the PURE decision "may this workspace's row mint a node in the shared graph?"
// (06-roadmap Phase 4 "CRM contributor controls"; 09-compliance rule 5).
//
// WHAT IT GATES, precisely. masterGraphRepository.resolveForImport does two different things behind one name:
//   LINK  — an existing golden person matched a deterministic key. Pure read, zero contribution.
//   MINT  — nothing matched, so this workspace's data creates a globally visible node.
// Only the MINT is a contribution. That distinction is the whole design: a denied row still LINKs, so the
// customer keeps every benefit of the shared graph on data that is already in it, and only stops ADDING.
// Gating the link too would be a silent product downgrade dressed as a privacy control.
//
// ── WHY THIS IS AN OPT-OUT, NOT AN OPT-IN (decisions.md D13) ─────────────────────────────────────────────────
// The obvious shape — default deny, contribute only when a workspace flips a switch — is wrong HERE, and the
// reason is ADR-0021. The mint this gate sits in front of is MATCH-AGAINST: identity and dedup keys only,
// email_enc NULL, no provenance, no profile fields. The repo already treats that as the CONTRIBUTE-TO-off
// state; contribution_policy.contribute_enabled is the switch for the Phase-3 co-op path that would write
// actual values, and it stays default-false and unread by this gate.
//
// Making the identity mint default-deny would stop the dedup spine growing for every existing tenant on the
// day the migration ships, silently, with no customer having asked for it — re-litigating ADR-0021 backwards
// under the name of a Phase 4 control. So the exclusion lists and never-share fields are what this gate reads,
// and they are enforced ALWAYS: an exclusion list that only binds when some other master switch is on is a
// trap, because the customer who wrote "never share acme.com" believes it is in force from the moment they
// saved it.
//
// PURE and total. The exclusions are loaded once per batch by the caller; this decides per row. Kept out of
// the repository because the repository runs under leadwolf_er, which cannot read the policy tables at all —
// the decision has to be made on the overlay side and carried in.

import type { NeverShareField } from "@leadwolf/types";

export interface ContributionGateInput {
  /** Registrable domains this workspace never contributes. Compared case-insensitively. */
  excludedDomains: ReadonlySet<string>;
  excludedAccountIds: ReadonlySet<string>;
  excludedContactIds: ReadonlySet<string>;
  /** Facets withheld from an otherwise-permitted mint. Enforced regardless of the co-op switch. */
  neverShareFields: readonly NeverShareField[];
}

export interface ContributionCandidate {
  contactId: string;
  accountId?: string | null;
  /** The company domain the row would mint against — already freemail-filtered by the caller. */
  registrableDomain?: string | null;
  /** The email domain, checked separately: a row can carry a personal-address domain and no account. */
  emailDomain?: string | null;
}

export type ContributionDenyReason = "contact_excluded" | "account_excluded" | "domain_excluded";

export interface ContributionVerdict {
  /** True only when this row may MINT. False still permits a LINK — see the file header. */
  mayMint: boolean;
  reason: ContributionDenyReason | null;
  /** Fields withheld even on an allowed mint. Empty when nothing is withheld. */
  withheldFields: NeverShareField[];
}

const DENIED = (reason: ContributionDenyReason): ContributionVerdict => ({
  mayMint: false,
  reason,
  withheldFields: [],
});

/**
 * Decide whether one row may contribute.
 *
 * Checks run narrowest-first — contact, then account, then domain — so the deny REASON reported back is the
 * most specific rule that fired. An admin auditing "why is this record not shared" needs the rule they wrote,
 * not the broadest one that happens to also cover it.
 *
 * Both the account domain and the email domain are checked against the domain list. Excluding acme.com and
 * still contributing the row because its account record happens to have no domain set is the exact hole a
 * customer would call a breach, and account domains are frequently blank on CRM-synced rows.
 */
export function evaluateContribution(
  policy: ContributionGateInput,
  candidate: ContributionCandidate,
): ContributionVerdict {
  if (policy.excludedContactIds.has(candidate.contactId)) return DENIED("contact_excluded");
  if (candidate.accountId && policy.excludedAccountIds.has(candidate.accountId)) {
    return DENIED("account_excluded");
  }
  for (const d of [candidate.registrableDomain, candidate.emailDomain]) {
    if (d && policy.excludedDomains.has(d.toLowerCase())) return DENIED("domain_excluded");
  }
  return { mayMint: true, reason: null, withheldFields: [...policy.neverShareFields] };
}

/**
 * Translate an allowed verdict into the mint restrictions the resolver understands.
 *
 * Returns undefined when nothing is withheld, so the common case passes no options at all and the resolver
 * takes its unchanged path — a gate that rewrites the hot path even when it has nothing to say is a gate that
 * eventually breaks the hot path. This is what keeps a workspace with no controls set byte-identical to how it
 * behaved before the gate existed.
 *
 * "company" implies "employment": an employment edge with no company is not expressible, so withholding the
 * company must withhold the edge or the mint fails on a null FK rather than declining politely.
 *
 * "phone" maps to nothing. The co-op-safe mint writes no phone at all today (phone resolution is deferred —
 * masterGraphRepository accepts phoneBlindIndex for forward-compat and never reads it), so honouring it is a
 * no-op. It stays in the vocabulary so a customer can express the rule now and it binds the day phones land,
 * rather than being silently accepted and then silently ignored after the behaviour changes.
 */
export function mintRestrictions(verdict: ContributionVerdict):
  | {
      withholdEmail?: boolean;
      withholdCompany?: boolean;
      withholdEmployment?: boolean;
      withholdLinkedin?: boolean;
    }
  | undefined {
  if (!verdict.mayMint || verdict.withheldFields.length === 0) return undefined;
  const f = new Set(verdict.withheldFields);
  const out = {
    withholdEmail: f.has("email") || undefined,
    withholdCompany: f.has("company") || undefined,
    withholdEmployment: f.has("employment") || f.has("company") || undefined,
    withholdLinkedin: f.has("linkedin") || undefined,
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}
