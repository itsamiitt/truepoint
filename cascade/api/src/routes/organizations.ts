import {
  type DbClient,
  type OrgTechRelationship,
  organizationRepository,
  personRepository,
  technologyRelationRepository,
} from "@cascade/db";
import { Hono } from "hono";
import {
  optionalEnum,
  parseBool,
  parseConfidence,
  parseDate,
  parseFields,
  parseLimit,
  requireEnum,
  requireId,
} from "../params";
import { badRequest, notFound } from "../problem";
import {
  educationDto,
  orgTechEdgeDto,
  organizationDto,
  personDto,
  positionDto,
} from "../serializers";

type Env = { Variables: { db: DbClient } };

export const organizationRoutes = new Hono<Env>();

// GET /organizations/identify — MUST precede /:org_id or "identify" parses as an id.
organizationRoutes.get("/identify", async (c) => {
  const db = c.get("db");
  const { domain, wikidata_qid, linkedin_slug, name, kind } = c.req.query();
  const keys = [domain, wikidata_qid, linkedin_slug, name].filter(Boolean);
  if (keys.length !== 1) {
    throw badRequest(
      "identify_key_required",
      "Provide exactly one lookup key.",
      "One of: domain, wikidata_qid, linkedin_slug, name.",
    );
  }
  const orgKind = optionalEnum(
    kind,
    ["company", "school", "nonprofit", "government", "other"] as const,
    "kind_invalid",
    "kind",
  );

  if (domain || wikidata_qid || linkedin_slug) {
    const idType = domain ? "domain" : wikidata_qid ? "wikidata_qid" : "linkedin_slug";
    const idValue = (domain ?? wikidata_qid ?? linkedin_slug) as string;
    const org = await organizationRepository.byIdentifier(db, idType, idValue);
    return c.json({
      matched_on: idValue,
      match_type: idType,
      matches: org ? [{ match_confidence: 1, organization: organizationDto(org) }] : [],
    });
  }

  const candidates = await organizationRepository.candidatesByName(db, name as string, orgKind);
  return c.json({
    matched_on: name,
    match_type: "name",
    matches: candidates.map((m) => ({
      match_confidence: m.match_confidence,
      organization: organizationDto(m.org),
    })),
  });
});

organizationRoutes.get("/:org_id", async (c) => {
  const db = c.get("db");
  const orgId = requireId(c.req.param("org_id"), "org", "org_id_invalid");
  const org = await organizationRepository.getById(db, orgId);
  if (!org) throw notFound("organization_not_found", "Organization not found.");

  const fields = parseFields(c.req.query("fields"));
  const extras: Record<string, unknown> = {};
  if (fields.has("aliases")) extras.aliases = await organizationRepository.aliases(db, orgId);
  if (fields.has("identifiers"))
    extras.identifiers = await organizationRepository.identifiers(db, orgId);
  return c.json({ organization: organizationDto(org, extras) });
});

// ⭐ The develops-vs-uses traversal. `relationship` is REQUIRED — there is no
// call shape that returns portfolio and stack together.
organizationRoutes.get("/:org_id/technologies", async (c) => {
  const db = c.get("db");
  const orgId = requireId(c.req.param("org_id"), "org", "org_id_invalid");
  const relationship = requireEnum(
    c.req.query("relationship"),
    ["develops", "uses", "resells"] as const,
    "relationship_required",
    "relationship",
  ) as OrgTechRelationship;

  const status = optionalEnum(
    c.req.query("status"),
    ["open", "closed", "all"] as const,
    "status_invalid",
    "status",
  );
  const opts = {
    status,
    minConfidence: parseConfidence(c.req.query("min_confidence")),
    asOf: parseDate(c.req.query("as_of"), "as_of"),
    closedSince: parseDate(c.req.query("closed_since"), "closed_since"),
    limit: parseLimit(c.req.query("limit")),
    cursor: c.req.query("cursor") ?? null,
  };

  const rows = await technologyRelationRepository.technologiesForOrg(db, orgId, relationship, opts);

  const fields = parseFields(c.req.query("fields"));
  let creators = new Map<
    string,
    { org_id: string; display_name: string | null; legal_name: string }
  >();
  if (fields.has("vendors") && rows.length > 0) {
    const found = await technologyRelationRepository.creatorsForTechnologies(
      db,
      rows.map((r) => r.technology_id),
    );
    creators = new Map(found.map((f) => [f.technology_id, f]));
  }

  const results = rows.map((r) => orgTechEdgeDto(r, creators.get(r.technology_id)));
  const last = rows.at(-1);
  return c.json({
    organization_id: orgId,
    relationship,
    results,
    next_cursor: rows.length === opts.limit && last ? last.rel_id : null,
  });
});

organizationRoutes.get("/:org_id/people", async (c) => {
  const db = c.get("db");
  const orgId = requireId(c.req.param("org_id"), "org", "org_id_invalid");
  const edge =
    optionalEnum(
      c.req.query("edge"),
      ["employment", "education"] as const,
      "edge_invalid",
      "edge",
    ) ?? "employment";
  const limit = parseLimit(c.req.query("limit"));

  if (edge === "education") {
    const status = optionalEnum(
      c.req.query("education_status"),
      ["current", "completed"] as const,
      "education_status_invalid",
      "education_status",
    );
    const rows = await personRepository.peopleWithEducationAtOrg(db, orgId, { status, limit });
    return c.json({
      organization_id: orgId,
      results: rows.map((r) => ({
        person: personDto(r),
        education: { education_id: r.education_id, degree: r.degree, ended_year: r.ended_year },
      })),
      next_cursor: null,
    });
  }

  const relationship = optionalEnum(
    c.req.query("relationship"),
    ["employee", "founder", "board_member", "advisor", "contractor", "intern"] as const,
    "relationship_invalid",
    "relationship",
  );
  const rows = await personRepository.peopleAtOrg(db, orgId, {
    relationship,
    current: parseBool(c.req.query("current"), "current"),
    function: c.req.query("function"),
    seniority: c.req.query("seniority"),
    limit,
  });
  return c.json({
    organization_id: orgId,
    results: rows.map((r) => ({
      person: personDto(r),
      position: {
        position_id: r.position_id,
        title: r.title,
        relationship: r.position_relationship,
      },
    })),
    next_cursor: null,
  });
});

export const personRoutes = new Hono<Env>();

personRoutes.get("/:person_id", async (c) => {
  const db = c.get("db");
  const personId = requireId(c.req.param("person_id"), "pn", "person_id_invalid");
  const person = await personRepository.getById(db, personId);
  if (!person) throw notFound("person_not_found", "Person not found.");

  const fields = parseFields(c.req.query("fields"));
  const extras: Record<string, unknown> = {};
  if (fields.has("positions")) {
    extras.positions = (await personRepository.positions(db, personId)).map(positionDto);
  }
  if (fields.has("educations")) {
    extras.educations = (await personRepository.educations(db, personId)).map(educationDto);
  }
  return c.json({ person: personDto(person, extras) });
});

personRoutes.get("/:person_id/positions", async (c) => {
  const db = c.get("db");
  const personId = requireId(c.req.param("person_id"), "pn", "person_id_invalid");
  const rows = await personRepository.positions(db, personId, {
    current: parseBool(c.req.query("current"), "current"),
    minConfidence: parseConfidence(c.req.query("min_confidence")),
  });
  return c.json({ person_id: personId, results: rows.map(positionDto), next_cursor: null });
});

personRoutes.get("/:person_id/educations", async (c) => {
  const db = c.get("db");
  const personId = requireId(c.req.param("person_id"), "pn", "person_id_invalid");
  const rows = await personRepository.educations(db, personId);
  return c.json({ person_id: personId, results: rows.map(educationDto), next_cursor: null });
});

personRoutes.get("/:person_id/colleagues", async (c) => {
  const db = c.get("db");
  const personId = requireId(c.req.param("person_id"), "pn", "person_id_invalid");
  const rows = await personRepository.colleagues(db, personId, {
    function: c.req.query("function"),
    limit: parseLimit(c.req.query("limit")),
  });
  return c.json({
    person_id: personId,
    results: rows.map((r) => ({
      person: personDto(r),
      shared_org_id: r.shared_org_id,
      title: r.title,
    })),
    next_cursor: null,
  });
});
