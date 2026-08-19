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

import { badgeHalfLifePolicy, buildConfidenceBadgeV1 } from "@leadwolf/core";
import {
  type Tx,
  accountRepository,
  accountSearchRepository,
  contactRepository,
  intentSignalRepository,
  masterEducationRepository,
  masterEmploymentReadRepository,
  masterJobPostingsRepository,
  masterProfileRepository,
  masterTechnologyRepository,
  provenanceBadgeRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  accountAlumniResponse,
  accountDisplacementResponse,
  accountHeadcountResponse,
  accountPostingsResponse,
  accountTechnologiesResponse,
  contactAttributesResponse,
  contactEducationResponse,
  contactEmploymentResponse,
  contactProvenanceResponse,
  contactSignalsResponse,
  maskedAccountSchema,
  technologyPeersResponse,
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

/**
 * GET /accounts/:accountId — the base masked-account DTO for the /companies/:id page (MI-1).
 * Overlay-only read under RLS: same SELECTION as account search, so the page and the grid never disagree.
 * No Layer-0 hop here — the momentum/technology/signals sections each have their own seams.
 */
accountIntelligenceRoutes.get("/:accountId", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("workspace_required");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const account = await withTenantTx(scope, (tx: Tx) =>
    accountSearchRepository.getMaskedById(tx, c.req.param("accountId")),
  );
  if (!account) throw new NotFoundError("Account not found.");
  return c.json({ account: maskedAccountSchema.parse(account) });
});

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
      accountTechnologiesResponse.parse({
        relationship,
        resolved: false,
        org_kind: null,
        technologies: [],
      }),
    );
  }

  let orgKind: string | null = null;
  const withVendors = (c.req.query("fields") ?? "")
    .split(",")
    .map((f) => f.trim())
    .includes("vendors");

  const payload = await withErTx(async (tx: Tx) => {
    // Read the institution kind in the SAME Layer-0 transaction — one round trip, and it cannot disagree
    // with the rows returned beside it.
    orgKind = await accountRepository.orgKindForMasterCompany(tx, masterCompanyId);
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
    accountTechnologiesResponse.parse({
      relationship,
      resolved: true,
      org_kind: orgKind,
      technologies: payload,
    }),
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
/**
 * GET /accounts/:accountId/displacement — what this organization recently STOPPED running.
 *
 * The sales trigger, read from CLOSED adoption episodes rather than inferred from an absence: an absence is
 * indistinguishable from "we never detected it", and firing a displacement play on that distinction is how
 * you email someone about migrating off a product they never had.
 *
 * ⚠ EMPTY TODAY: nothing populates master_technology_adoptions, so removed_at is never set. The surface is
 * correct-when-data-arrives; it is not currently useful, and it says so rather than implying "nothing dropped".
 */
accountIntelligenceRoutes.get("/:accountId/displacement", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view displacement.");
  }

  const rawDays = Number(c.req.query("within_days") ?? 180);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 730) {
    throw new ValidationError("'within_days' must be an integer between 1 and 730.", {
      code: "within_days_invalid",
    });
  }

  const { masterCompanyId } = await resolveBridge(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("accountId"),
  );
  if (!masterCompanyId) {
    return c.json(
      accountDisplacementResponse.parse({ resolved: false, within_days: rawDays, removed: [] }),
    );
  }

  const rows = await withErTx(async (tx: Tx) =>
    masterTechnologyRepository.listRecentlyRemovedTechnologies(tx, masterCompanyId, rawDays),
  );

  return c.json(
    accountDisplacementResponse.parse({
      resolved: true,
      within_days: rawDays,
      removed: rows.map((r) => ({
        technology_id: r.technologyId,
        slug: r.slug,
        canonical_name: r.canonicalName,
        detection_method: r.detectionMethod,
        first_seen_at: r.firstSeenAt,
        last_seen_at: r.lastSeenAt,
        removed_at: r.removedAt,
      })),
    }),
  );
});

/**
 * GET /accounts/:accountId/alumni — which of MY contacts studied at this institution.
 *
 * NOT "everyone in the graph who studied there". That answer spans every tenant, and returning it would hand
 * the caller the population of a dataset they have not earned. This runs the graph traversal, then maps the
 * result back through the overlay under RLS — so a caller sees only their own contacts, which is both the
 * useful question and the only askable one.
 *
 * Three transactions, and the order is the security argument: resolve the account (tenant, RLS) → traverse
 * Layer 0 (er) → map people back to contacts (tenant, RLS). Layer-0 person ids never leave the server.
 */
accountIntelligenceRoutes.get("/:accountId/alumni", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view alumni.");
  }
  const scope = { tenantId: c.get("tenantId"), workspaceId };

  const { masterCompanyId } = await resolveBridge(scope, c.req.param("accountId"));
  if (!masterCompanyId) {
    return c.json(accountAlumniResponse.parse({ resolved: false, is_school: false, alumni: [] }));
  }

  const { kind, graduates } = await withErTx(async (tx: Tx) => ({
    kind: await accountRepository.orgKindForMasterCompany(tx, masterCompanyId),
    graduates: await masterEducationRepository.listAlumni(tx, masterCompanyId, {
      status: "completed",
    }),
  }));

  // Not a school → there is nothing coherent to show. Say so rather than returning an empty alumni list,
  // which would read as "this university has no alumni".
  if (kind !== "school" || graduates.length === 0) {
    return c.json(
      accountAlumniResponse.parse({ resolved: true, is_school: kind === "school", alumni: [] }),
    );
  }

  const byPerson = new Map(graduates.map((g) => [g.masterPersonId, g]));
  const mine = await withTenantTx(scope, async (tx: Tx) =>
    contactRepository.findByMasterPersonIds(tx, [...byPerson.keys()]),
  );

  return c.json(
    accountAlumniResponse.parse({
      resolved: true,
      is_school: true,
      alumni: mine.map((contact) => {
        const edu = contact.masterPersonId ? byPerson.get(contact.masterPersonId) : undefined;
        return {
          contact_id: contact.id,
          first_name: contact.firstName,
          last_name: contact.lastName,
          job_title: contact.jobTitle,
          degree: edu?.degree ?? null,
          ended_on: edu?.endedOn ?? null,
        };
      }),
    }),
  );
});

/**
 * GET /accounts/:accountId/technologies/:technologyId/peers — who ELSE in my workspace runs this.
 *
 * The reverse traversal, deliberately scoped rather than global. Account search already filters by
 * technology off accounts.technologies (the inferred rollup); a second, Layer-0-backed global filter would
 * give the product two controls with the same name and different data — the confusion this model exists to
 * remove — and would pre-empt a cutover decision that belongs to the owner (plan 33 §6). Scoping the answer
 * to one technology reached from one open account keeps it useful and creates nothing to reconcile.
 *
 * Three transactions again, same order and same reason: resolve the account (tenant, RLS) → traverse the
 * shared graph (er) → map adopters back to the caller's own accounts (tenant, RLS). Layer-0 company ids
 * never leave the server, and the caller learns nothing about tenants other than their own.
 */
accountIntelligenceRoutes.get("/:accountId/technologies/:technologyId/peers", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view peer adopters.");
  }
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const accountId = c.req.param("accountId");
  const technologyId = c.req.param("technologyId");

  // The account must be visible first — otherwise this is a graph read keyed on a client-supplied id.
  await resolveBridge(scope, accountId);

  const adopters = await withErTx(async (tx: Tx) =>
    masterTechnologyRepository.listTechnologyAdopters(tx, technologyId),
  );
  const seenAt = new Map(adopters.map((a) => [a.masterCompanyId, a.lastSeenAt]));

  const mine = await withTenantTx(scope, async (tx: Tx) =>
    accountRepository.findByMasterCompanyIds(tx, [...seenAt.keys()], {
      excludeAccountId: accountId,
    }),
  );

  return c.json(
    technologyPeersResponse.parse({
      technology_id: technologyId,
      peers: mine.map((a) => ({
        account_id: a.id,
        name: a.name,
        domain: a.domain,
        last_seen_at: seenAt.get(a.masterCompanyId) as Date,
      })),
    }),
  );
});

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
  const halfLifePolicy = await badgeHalfLifePolicy();
  for (const field of ["email", "phone"] as const) {
    const badge = buildConfidenceBadgeV1(field, aggregate, new Date(), halfLifePolicy);
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

/**
 * GET /contacts/:contactId/employment — the career history we hold for this person.
 *
 * Same two-transaction shape as its siblings. Public professional facts only: employer, title, dates. No
 * contact values, no contributor reference, no Layer-0 ids.
 *
 * HONESTY NOTE for whoever renders this: today the import path mints a BARE edge (company + is_current +
 * is_primary), so `title` and both dates are usually null. Design for a company list, not a timeline of
 * blank rows — see plan 33 §A2.
 */
contactIntelligenceRoutes.get("/:contactId/employment", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view employment history.");
  }

  const contact = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx: Tx) =>
    contactRepository.getMasterPersonBridge(tx, c.req.param("contactId")),
  );
  if (!contact) throw new NotFoundError("Contact not found.");

  if (!contact.masterPersonId) {
    return c.json(contactEmploymentResponse.parse({ resolved: false, employment: [] }));
  }

  const stints = await withErTx(async (tx: Tx) =>
    masterEmploymentReadRepository.listPersonEmployment(tx, contact.masterPersonId as string),
  );

  return c.json(
    contactEmploymentResponse.parse({
      resolved: true,
      employment: stints.map((s) => ({
        company_name: s.companyName,
        org_kind: s.orgKind,
        title: s.title,
        department: s.department,
        seniority_level: s.seniorityLevel,
        started_on: s.startedOn,
        ended_on: s.endedOn,
        is_current: s.isCurrent,
        is_primary: s.isPrimary,
        confidence: s.confidence === null ? null : Number(s.confidence),
        source_count: s.sourceCount,
      })),
    }),
  );
});

/**
 * GET /contacts/:contactId/signals — what we have observed about this contact.
 *
 * The ONE endpoint in this file that never touches Layer 0: intent_signals is tenant-private and
 * workspace-scoped, so a single withTenantTx under RLS is the whole security story. No er transaction, no
 * bridge, no wall to cross.
 *
 * It is also the only signal surface with real data today — recordJobChange (the S-13 job-change sweep)
 * writes job_change rows. The other eight enum values have no producer, which is precisely why this returns
 * the rows that exist rather than a bucket per type: listing nine categories would advertise coverage the
 * product cannot deliver.
 */
contactIntelligenceRoutes.get("/:contactId/signals", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view signals.");
  }

  const signals = await withTenantTx(
    { tenantId: c.get("tenantId"), workspaceId },
    async (tx: Tx) => {
      // Prove the contact is visible in THIS workspace before reading anything about it. RLS already scopes
      // intent_signals, but a bare signal read on an unknown id would answer "no signals" for a contact in
      // another tenant — indistinguishable from a real empty, and a weak enumeration oracle.
      const contact = await contactRepository.getMasterPersonBridge(tx, c.req.param("contactId"));
      if (!contact) return null;
      return intentSignalRepository.recentForContact(tx, contact.id);
    },
  );
  if (signals === null) throw new NotFoundError("Contact not found.");

  return c.json(
    contactSignalsResponse.parse({
      signals: signals.map((s) => ({
        signal_type: s.signalType,
        weight: s.weight,
        detected_at: s.detectedAt,
      })),
    }),
  );
});

/**
 * GET /contacts/:contactId/attributes — skills + languages we hold for this person (0116;
 * linkedin-source-ingestion §read surfaces).
 *
 * Same two-transaction shape as employment/education. Public professional facts only. Suppression-safe by
 * construction: the DSAR fan-out DELETES the underlying rows, so a suppressed subject reads as empty —
 * there is nothing here for a suppressed person that the route would need to mask.
 */
contactIntelligenceRoutes.get("/:contactId/attributes", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view contact attributes.");
  }

  const contact = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx: Tx) =>
    contactRepository.getMasterPersonBridge(tx, c.req.param("contactId")),
  );
  if (!contact) throw new NotFoundError("Contact not found.");

  if (!contact.masterPersonId) {
    return c.json(contactAttributesResponse.parse({ resolved: false, skills: [], languages: [] }));
  }
  const masterPersonId = contact.masterPersonId;

  const { skills, languages } = await withErTx(async (tx: Tx) => ({
    skills: await masterProfileRepository.listPersonSkills(tx, masterPersonId),
    languages: await masterProfileRepository.listPersonLanguages(tx, masterPersonId),
  }));

  return c.json(
    contactAttributesResponse.parse({
      resolved: true,
      skills: skills.map((s) => ({ skill: s.skill, source_count: s.sourceCount })),
      languages: languages.map((l) => ({ name: l.name, proficiency: l.proficiency })),
    }),
  );
});

/**
 * GET /:accountId/headcount — the monthly headcount totals series for this account's company (0114).
 *
 * Newest-first; growth windows are DERIVED by the client over ≤36 points (the no-rollup rule — storing a
 * growth number would just be a second copy that drifts). Company-level business data: no person, no PII.
 */
accountIntelligenceRoutes.get("/:accountId/headcount", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view headcount.");
  }

  const { masterCompanyId } = await resolveBridge(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("accountId"),
  );
  if (!masterCompanyId) {
    return c.json(accountHeadcountResponse.parse({ resolved: false, series: [] }));
  }

  const series = await withErTx(async (tx: Tx) =>
    masterProfileRepository.listHeadcountTotals(tx, masterCompanyId, 36),
  );

  return c.json(
    accountHeadcountResponse.parse({
      resolved: true,
      series: series.map((p) => ({ month: p.month, employee_count: p.employeeCount })),
    }),
  );
});

/**
 * GET /:accountId/postings — open job postings for this account's company (0127, MI-S1).
 * Same two-transaction shape as headcount. Organization facts only — the table carries no person data by
 * design. Empty until the D-6 licensed postings feed lands; the UI self-hides on an empty answer.
 */
accountIntelligenceRoutes.get("/:accountId/postings", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to view postings.");
  }

  const { masterCompanyId } = await resolveBridge(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("accountId"),
  );
  if (!masterCompanyId) {
    return c.json(accountPostingsResponse.parse({ resolved: false, postings: [], by_department: [] }));
  }

  const [postings, byDepartment] = await withErTx(async (tx: Tx) =>
    Promise.all([
      masterJobPostingsRepository.listOpenForCompany(tx, masterCompanyId, 50),
      masterJobPostingsRepository.countOpenByDepartment(tx, masterCompanyId),
    ]),
  );

  return c.json(
    accountPostingsResponse.parse({
      resolved: true,
      postings: postings.map((p) => ({
        title: p.title,
        department: p.department,
        seniority_level: p.seniorityLevel,
        location: p.location,
        posted_at: p.postedAt,
      })),
      by_department: byDepartment,
    }),
  );
});
