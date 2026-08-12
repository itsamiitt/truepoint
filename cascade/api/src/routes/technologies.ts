import {
  type DbClient,
  type OrgTechRelationship,
  evidenceFor,
  technologyRelationRepository,
  technologyRepository,
} from "@cascade/db";
import { Hono } from "hono";
import {
  optionalEnum,
  parseConfidence,
  parseDate,
  parseFields,
  parseLimit,
  requireEnum,
  requireId,
} from "../params";
import { badRequest, notFound } from "../problem";
import { orgTechEdgeDto, organizationDto, technologyDto } from "../serializers";

type Env = { Variables: { db: DbClient } };

export const technologyRoutes = new Hono<Env>();

technologyRoutes.get("/identify", async (c) => {
  const db = c.get("db");
  const { name, cpe23, wikidata_qid } = c.req.query();
  const keys = [name, cpe23, wikidata_qid].filter(Boolean);
  if (keys.length !== 1) {
    throw badRequest(
      "identify_key_required",
      "Provide exactly one lookup key.",
      "One of: name, cpe23, wikidata_qid.",
    );
  }
  const matches = await technologyRepository.resolve(db, { name, cpe23, wikidata_qid });
  return c.json({
    matched_on: keys[0],
    match_type: name ? "name" : cpe23 ? "cpe23" : "wikidata_qid",
    matches: matches.map((m) => ({
      match_confidence: m.match_confidence,
      technology: technologyDto(m.tech),
    })),
  });
});

technologyRoutes.get("/:technology_id", async (c) => {
  const db = c.get("db");
  const techId = requireId(c.req.param("technology_id"), "tech", "technology_id_invalid");
  const tech = await technologyRepository.getById(db, techId);
  if (!tech) throw notFound("technology_not_found", "Technology not found.");

  const fields = parseFields(c.req.query("fields"));
  const extras: Record<string, unknown> = {};
  if (fields.has("aliases")) extras.aliases = await technologyRepository.aliases(db, techId);
  if (fields.has("vendors")) {
    extras.vendors = (await technologyRelationRepository.vendorsForTechnology(db, techId)).map(
      (v) => ({
        link_id: v.link_id,
        organization: { org_id: v.org_id, legal_name: v.legal_name, display_name: v.display_name },
        relationship: v.relationship,
        confidence: Number(v.confidence),
        valid_from: v.valid_from,
        valid_to: v.valid_to,
      }),
    );
  }
  return c.json({ technology: technologyDto(tech, extras) });
});

// The reverse traversal: adopters (uses) or makers (develops).
technologyRoutes.get("/:technology_id/organizations", async (c) => {
  const db = c.get("db");
  const techId = requireId(c.req.param("technology_id"), "tech", "technology_id_invalid");
  const relationship = requireEnum(
    c.req.query("relationship"),
    ["uses", "develops", "resells"] as const,
    "relationship_required",
    "relationship",
  ) as OrgTechRelationship;

  const opts = {
    status: optionalEnum(
      c.req.query("status"),
      ["open", "closed", "all"] as const,
      "status_invalid",
      "status",
    ),
    minConfidence: parseConfidence(c.req.query("min_confidence")),
    asOf: parseDate(c.req.query("as_of"), "as_of"),
    closedSince: parseDate(c.req.query("closed_since"), "closed_since"),
    limit: parseLimit(c.req.query("limit")),
    cursor: c.req.query("cursor") ?? null,
  };

  const rows = await technologyRelationRepository.orgsForTechnology(db, techId, relationship, opts);
  const last = rows.at(-1);
  return c.json({
    technology_id: techId,
    relationship,
    results: rows.map((r) => ({
      organization: organizationDto({
        org_id: r.org_id,
        org_kind: r.org_kind,
        legal_name: r.legal_name,
        display_name: r.display_name,
        primary_domain: null,
        country_code: null,
        employee_range: null,
        founded_year: null,
        institution_type: null,
        confidence: r.confidence,
      }),
      edge: orgTechEdgeDto(r),
    })),
    next_cursor: rows.length === opts.limit && last ? last.rel_id : null,
  });
});

technologyRoutes.get("/:technology_id/vendors", async (c) => {
  const db = c.get("db");
  const techId = requireId(c.req.param("technology_id"), "tech", "technology_id_invalid");
  const asOf = parseDate(c.req.query("as_of"), "as_of");
  const rows = await technologyRelationRepository.vendorsForTechnology(db, techId, asOf);
  return c.json({
    technology_id: techId,
    results: rows.map((v) => ({
      link_id: v.link_id,
      organization: { org_id: v.org_id, legal_name: v.legal_name, display_name: v.display_name },
      relationship: v.relationship,
      confidence: Number(v.confidence),
      valid_from: v.valid_from,
      valid_to: v.valid_to,
    })),
  });
});

export const evidenceRoutes = new Hono<Env>();

// One endpoint for every edge type — the id prefix routes to its table.
evidenceRoutes.get("/:edge_id", async (c) => {
  const db = c.get("db");
  const edgeId = c.req.param("edge_id");
  const prefix = edgeId.split("_")[0] ?? "";
  if (!["pos", "edu", "rel", "tv", "ce"].includes(prefix)) {
    throw badRequest(
      "edge_id_invalid",
      "Unrecognized edge id prefix.",
      "Expected one of: pos_ (position), edu_ (education), rel_ (org-technology), tv_ (vendor), ce_ (org-org).",
    );
  }
  const { edgeTable, attestations, fused } = await evidenceFor(db, edgeId);
  if (fused === null) throw notFound("edge_not_found", "Edge not found.");

  const edgeKind = {
    person_positions: "person_position",
    person_educations: "person_education",
    org_technology_relations: "org_technology_relation",
    technology_vendors: "technology_vendor",
    company_edges: "company_edge",
  }[edgeTable];

  return c.json({
    edge_id: edgeId,
    edge_kind: edgeKind,
    fused_confidence: fused,
    attestations: attestations.map((a) => ({
      source_id: a.source_id,
      source_class: a.source_class,
      confidence: Number(a.confidence),
      raw_assertion: a.raw_assertion,
      seen_at: a.seen_at,
    })),
  });
});

export const metaRoutes = new Hono<Env>();

metaRoutes.get("/taxonomies/technology-categories", async (c) => {
  const db = c.get("db");
  return c.json({ results: await technologyRepository.categories(db) });
});
