// contribution.ts — the vocabulary for what a workspace will and will not contribute to the shared graph
// (06-roadmap Phase 4 "CRM contributor controls"; 09-compliance rule 5). Shared by the API contract, the
// repository and the pure evaluator so all three agree on what "excluded" means.

import { z } from "zod";

/** What an exclusion entry points at. Ordered narrowest-last; the evaluator checks all three. */
export const contributionExclusionKind = z.enum(["domain", "account", "contact"]);
export type ContributionExclusionKind = z.infer<typeof contributionExclusionKind>;

/**
 * The fields a workspace may mark never-share.
 *
 * A CLOSED list, not free text. The set exists to SUBTRACT from what the co-op-safe mint boundary already
 * allows, and an unrecognised string would subtract nothing while reading, to the customer, exactly like a
 * working rule. Anything not listed here is either never contributed anyway (job titles, names — they stay in
 * the overlay) or not separable from identity itself.
 */
export const neverShareField = z.enum([
  "email", // suppresses the master_emails blind-index facet — the person still resolves, the email does not
  "phone",
  "company", // no master_companies mint from this workspace's domains
  "employment", // no employment edge — the person may exist, the where-they-work does not
  "linkedin", // no linkedin_public_id on a minted person; identity falls back to the email key
]);
export type NeverShareField = z.infer<typeof neverShareField>;

/** CRM objects a per-object opt-in can be expressed for. Mirrors crm_field_mappings.object_type. */
export const crmContributionObject = z.enum(["contact", "account", "lead", "deal"]);
export type CrmContributionObject = z.infer<typeof crmContributionObject>;

export const contributionPolicySchema = z.object({
  workspaceId: z.string().uuid(),
  contributeEnabled: z.boolean(),
  neverShareFields: z.array(neverShareField),
  policyVersion: z.string(),
  enabledAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});
export type ContributionPolicy = z.infer<typeof contributionPolicySchema>;

export const contributionExclusionSchema = z.object({
  id: z.string().uuid(),
  kind: contributionExclusionKind,
  domain: z.string().nullable(),
  accountId: z.string().uuid().nullable(),
  contactId: z.string().uuid().nullable(),
  note: z.string().max(200).nullable(),
});
export type ContributionExclusion = z.infer<typeof contributionExclusionSchema>;

/** The write shape for adding one exclusion. The kind/target pairing is checked by the DB CHECK as well. */
export const createContributionExclusionSchema = z
  .object({
    kind: contributionExclusionKind,
    domain: z.string().trim().min(1).max(253).optional(),
    accountId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine(
    (v) =>
      (v.kind === "domain" && !!v.domain && !v.accountId && !v.contactId) ||
      (v.kind === "account" && !!v.accountId && !v.domain && !v.contactId) ||
      (v.kind === "contact" && !!v.contactId && !v.domain && !v.accountId),
    { message: "exactly one target must be set, matching kind" },
  );
export type CreateContributionExclusion = z.infer<typeof createContributionExclusionSchema>;

/**
 * The default when a workspace has NO policy row: the CO-OP opt-in off, nothing restricted.
 *
 * `contributeEnabled` governs the Phase-3 path that would contribute actual VALUES, and defaults off because
 * an opt-in that defaults on is not an opt-in. It does NOT govern the ADR-0021 identity mint, which the repo
 * already treats as the contribute-off state — the exclusion lists and never-share fields are what restrict
 * that, and they restrict from shipped behaviour rather than replacing it (decisions.md D13).
 */
export const DEFAULT_CONTRIBUTION_POLICY = {
  contributeEnabled: false,
  neverShareFields: [] as NeverShareField[],
} as const;
