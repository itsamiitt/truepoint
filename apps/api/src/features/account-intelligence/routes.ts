// routes.ts — the typed Layer-0 traversal, exposed on the tenant-visible account.
//
// This is the first API surface over the master graph. Layer 0 is system-owned and REVOKE'd from
// leadwolf_app, so a route cannot simply query it: every read here is TWO transactions, in this order.
//
//   1. withTenantTx  — resolve :accountId inside the caller's workspace. RLS enforces the tenancy check,
//                      so an account belonging to another tenant returns nothing and we 404. This step
//                      also yields master_company_id, the ONLY bridge from the overlay into Layer 0.
//   2. withErTx      — read Layer 0 for that ONE resolved master id, under the least-privilege
//                      leadwolf_er role.
//
// The order matters and is not an implementation detail: step 1 is what makes step 2 safe. A route that
// took a master_company_id from the client would let any caller read any company in the shared graph.
// The client never sees or supplies a Layer-0 id — it addresses its own account, and the server resolves.
//
// ⭐ `relationship` is a REQUIRED query parameter. "What does this company BUILD" (master_technology_vendors)
// and "what does it RUN" (master_technology_adoptions) are different facts from different tables, and there
// is deliberately no call shape that returns them merged — asking the ambiguous question is a 400.
//
// COMPLIANCE: no personal data crosses this boundary. Technology adoption and vendor rows describe
// ORGANIZATIONS, not people; the response carries no contact values, no person ids, and no contributor
// reference. The education route below is the one that touches personal data — see its own note.

import { buildConfidenceBadgeV1 } from "@leadwolf/core";
import {
  type Tx,
  accountRepository,
  contactRepository,
  masterEducationRepository,
  masterTechnologyRepository,
  provenanceBadgeRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  accountTechnologiesResponse,
  contactEducationResponse,
  contactProvenanceResponse,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const accountIntelligenceRoutes = new Hono<{ Variables: TenancyVariables }>();

accountIntelligenceRoutes.use("*", authn);
accountIntelligenceRoutes.use("*", tenancy);
accountIntelligenceRoutes.use("*", requireRole("owner", "admin", "member", "viewer"));

const RELATIONSHIPS = ["develops", "uses"] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

/**
 * Step 1 of the two-transaction pattern: prove the caller may see this account, and get its bridge.
 * Returns null when the account is missing OR belongs to another workspace — the two are deliberately
 * indistinguishable to the caller so account ids cannot be enumerated.
 */
async function resolveBridge(
  scope: { tenantId: string; workspaceId: string },
  accountId: string,
): Promise<{ masterCompanyId: string | null }> {
  const account = await withTenantTx(scope, async (tx: Tx) =>
    accountRepository.getByIdForIntelligence(tx, accountId),
  );
  if (!account) throw new NotFoundError("Account not found.");
  return { masterCompanyId: account.masterCompanyId };
}

accountIntelligenceRoutes.get("/:accountId/technologies", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view account intelligence.");
  }

  const relationship = c.req.query("relationship");
  if (!relationship || !RELATIONSHIPS.includes(relationship as Relationship)) {
    // Not a default, and not a guess: the two answers are disjoint and the caller must say which it wants.
    throw new ValidationError(
      `'relationship' is required and must be one of: ${RELATIONSHIPS.join(", ")}. 'develops' returns the company's own products; 'uses' returns technology detected in its stack.`,
      { code: "relationship_required", allowed: RELATIONSHIPS },
    );
  }

  const { masterCompanyId } = await resolveBridge(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("accountId"),
  );

  // An account that ER has not yet bridged to the shared graph has no Layer-0 answer. That is a normal
  // state, not an error — say so explicitly rather than returning a bare empty list that reads as
  // "this company builds nothing".
  if (!masterCompanyId) {
    return c.json(
      accountTechnologiesResponse.parse({ relationship, resolved: false, technologies: [] }),
    );
  }

  const withVendors = (c.req.query("fields") ?? "")
    .split(",")
    .map((f) => f.trim())
    .includes("vendors");

  const payload = await withErTx(async (tx: Tx) => {
    if (relationship === "develops") {
      const products = await masterTechnologyRepository.listCompanyProducts(tx, masterCompanyId);
      return products.map((p) => ({
        technology_id: p.technologyId,
        slug: p.slug,
        canonical_name: p.canonicalName,
        relationship: "develops" as const,
        ownership: p.relationship,
        started_on: p.startedOn,
        confidence: p.confidence === null ? null : Number(p.confidence),
      }));
    }

    const adoptions = await masterTechnologyRepository.listCompanyTechnologies(tx, masterCompanyId);
    const creators = withVendors
      ? await masterTechnologyRepository.listCreatorsForTechnologies(
          tx,
          adoptions.map((a) => a.technologyId),
        )
      : new Map();

    return adoptions.map((a) => {
      const creator = creators.get(a.technologyId);
      return {
        technology_id: a.technologyId,
        slug: a.slug,
        canonical_name: a.canonicalName,
        relationship: "uses" as const,
        detection_method: a.detectionMethod,
        first_seen_at: a.firstSeenAt,
        last_seen_at: a.lastSeenAt,
        source_count: a.sourceCount,
        confidence: a.confidence === null ? null : Number(a.confidence),
        // "…and who built it" — the second typed hop, only when asked for.
        ...(creator ? { creator: { name: creator.companyName } } : {}),
      };
    });
  });

  // Egress-validated against the shared contract: adding a column to a Layer-0 table must never silently
  // start shipping it to customers.
  return c.json(
    accountTechnologiesResponse.parse({ relationship, resolved: true, technologies: payload }),
  );
});

/**
 * GET /contacts/:contactId/education — where did this person study.
 *
 * Same two-transaction shape as the technologies route, over the person bridge instead of the company one.
 *
 * COMPLIANCE: this is the one route in this file that touches PERSONAL data. It ships institution, degree,
 * fields of study and dates — public professional facts, the same class as employment history, and the same
 * class the contact record already exposes. It ships NO contact values (master_education holds none), no
 * contributor reference, and no Layer-0 ids the caller could use to address the shared graph directly. DSAR
 * erasure reaches these rows through the existing master_persons cascade (ON DELETE CASCADE on
 * master_person_id), so nothing new is orphaned by an erasure.
 */
export const contactIntelligenceRoutes = new Hono<{ Variables: TenancyVariables }>();

contactIntelligenceRoutes.use("*", authn);
contactIntelligenceRoutes.use("*", tenancy);
contactIntelligenceRoutes.use("*", requireRole("owner", "admin", "member", "viewer"));

contactIntelligenceRoutes.get("/:contactId/education", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view contact education.");
  }

  const contact = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx: Tx) =>
    contactRepository.getMasterPersonBridge(tx, c.req.param("contactId")),
  );
  if (!contact) throw new NotFoundError("Contact not found.");

  if (!contact.masterPersonId) {
    return c.json(contactEducationResponse.parse({ resolved: false, education: [] }));
  }

  const rows = await withErTx(async (tx: Tx) =>
    masterEducationRepository.listPersonEducation(tx, contact.masterPersonId as string),
  );

  const today = new Date().toISOString().slice(0, 10);
  return c.json(
    contactEducationResponse.parse({
      resolved: true,
      education: rows.map((r) => ({
        id: r.id,
        school_name: r.schoolName,
        resolved: r.masterCompanyId !== null,
        org_kind: r.orgKind,
        degree: r.degree,
        fields_of_study: r.fieldsOfStudy ?? [],
        started_on: r.startedOn === "-infinity" ? null : r.startedOn,
        ended_on: r.endedOn,
        // DERIVED here, exactly as the schema intends — there is no stored alumnus flag to read.
        completed: r.endedOn !== null && r.endedOn <= today,
        confidence: r.confidence === null ? null : Number(r.confidence),
        source_count: r.sourceCount,
      })),
    }),
  );
});

/**
 * GET /contacts/:contactId/provenance — why we believe what we hold about this person.
 *
 * The confidence model shipped long before this endpoint, but it surfaced ONLY inside RevealDialog, so a
 * customer saw the evidence at the instant they spent a credit and never again. This is the same badge,
 * readable for free on a record they already own — the S-10 "confidence visible at a glance" outcome.
 *
 * COMPLIANCE (C-02): the aggregate is computed by provenanceBadgeRepository, which counts contributors with
 * `count(DISTINCT contributor_ref)` INSIDE the query — the identity never appears in a result column, so no
 * caller can leak it by forgetting to strip a field. This route carries that forward: counts, a recency, a
 * band and a method. No source names, no contributor reference, no raw event log.
 *
 * A null badge and a zero badge are different answers. `badgeFor` returns null when the entity has no events
 * at all, and the response then omits the field rather than claiming "0 sources" — most records hold no
 * events yet, and a zero would read as a verdict on the data instead of an absence of log.
 */
contactIntelligenceRoutes.get("/:contactId/provenance", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view record provenance.");
  }

  const contact = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx: Tx) =>
    contactRepository.getMasterPersonBridge(tx, c.req.param("contactId")),
  );
  if (!contact) throw new NotFoundError("Contact not found.");

  if (!contact.masterPersonId) {
    return c.json(contactProvenanceResponse.parse({ resolved: false, fields: [] }));
  }

  const aggregate = await withErTx(async (tx: Tx) =>
    provenanceBadgeRepository.badgeFor(tx, "person", contact.masterPersonId as string),
  );

  // The pure builder is the ONLY place a score is assembled, so the API, the reveal dialog and any exporter
  // cannot compute different numbers from the same evidence.
  const fields: Array<{
    field: string;
    band: string;
    last_verified_at: string | null;
    age_days: number | null;
    source_count: number;
    strongest_method: string | null;
  }> = [];
  for (const field of ["email", "phone"] as const) {
    const badge = buildConfidenceBadgeV1(field, aggregate);
    if (!badge) continue; // no evidence for this field — omit it, never render a zero
    fields.push({
      field,
      band: badge.band,
      last_verified_at: badge.lastVerifiedAt,
      age_days: badge.ageDays,
      source_count: badge.sourceCount,
      strongest_method: badge.strongestMethod,
    });
  }

  return c.json(contactProvenanceResponse.parse({ resolved: true, fields }));
});
