// The brief's example, as data. This is the fixture every acceptance test
// (07 T1–T11) and every doc query in 05 runs against.
//
//   Alex  —works at→ Sage        Alex —studied at→ SPPU
//   Siya  —works at→ Sage        Siya —studied at→ DPU
//   Sage  —develops→ Sage Intacct, Sage 50, Sage X3
//   Sage  —uses→     WordPress, Google Analytics, Google Keyword Planner
//   Google —develops→ Google Analytics, Google Keyword Planner
//   (+ the Intacct acquisition: creator = Intacct Inc., current_owner = Sage since 2017)

import type { DbClient } from "./client";
import { attest } from "./edges";

// Seed ids are deterministic and readable, but must still be VALID Crockford
// base32 — the alphabet excludes I, L, O and U (they collide with 1/0/V when
// read aloud). Labels are transliterated rather than hand-typed, because
// hand-typed fixtures silently violate the id contract the API validates.
const CROCKFORD_SUBSTITUTIONS: Record<string, string> = { I: "1", L: "1", O: "0", U: "V" };

function seedId(prefix: string, label: string): string {
  const body = label
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[ILOU]/g, (ch) => CROCKFORD_SUBSTITUTIONS[ch] as string);
  return `${prefix}_SEED${body.padEnd(22, "0").slice(0, 22)}`;
}

export const EXAMPLE_IDS = {
  srcProvider: seedId("src", "PROVIDER"),
  srcWeb: seedId("src", "WEBPUBLIC"),
  srcCatalog: seedId("src", "CATALOG"),
  orgSage: seedId("org", "SAGE"),
  orgGoogle: seedId("org", "GOOGLE"),
  orgIntacct: seedId("org", "INTACCTINC"),
  orgAutomattic: seedId("org", "AUTOMATTIC"),
  orgSppu: seedId("org", "SPPU"),
  orgDpu: seedId("org", "DPU"),
  pnAlex: seedId("pn", "ALEX"),
  pnSiya: seedId("pn", "SIYA"),
  techIntacct: seedId("tech", "INTACCT"),
  techSage50: seedId("tech", "SAGE50"),
  techSageX3: seedId("tech", "SAGEX3"),
  techWordpress: seedId("tech", "WORDPRESS"),
  techGa: seedId("tech", "GA"),
  techGkp: seedId("tech", "GKP"),
  catErp: seedId("cat", "ERP"),
  catCms: seedId("cat", "CMS"),
  catAnalytics: seedId("cat", "ANALYTICS"),
  posAlexSage: seedId("pos", "ALEXSAGE"),
  posSiyaSage: seedId("pos", "SIYASAGE"),
  eduAlexSppu: seedId("edu", "ALEXSPPU"),
  eduSiyaDpu: seedId("edu", "SIYADPU"),
  relDevIntacct: seedId("rel", "DEVINTACCT"),
  relDevSage50: seedId("rel", "DEVSAGE50"),
  relDevSageX3: seedId("rel", "DEVSAGEX3"),
  relDevGa: seedId("rel", "DEVGA"),
  relDevGkp: seedId("rel", "DEVGKP"),
  relDevWordpress: seedId("rel", "DEVWORDPRESS"),
  relUseWordpress: seedId("rel", "USEWORDPRESS"),
  relUseGa: seedId("rel", "USEGA"),
  relUseGkp: seedId("rel", "USEGKP"),
} as const;

export { seedId };

const T0 = "2020-01-01T00:00:00Z";

export async function seedExample(db: DbClient): Promise<void> {
  const E = EXAMPLE_IDS;

  await db.query(
    `INSERT INTO sources (source_id, name, source_type, license_class, reliability) VALUES
      ($1,'Licensed Provider','licensed_provider','provider_b2b_resale',0.90),
      ($2,'Company website','web_crawl','open_web',0.85),
      ($3,'Product catalog','registry','registry_public',0.92)`,
    [E.srcProvider, E.srcWeb, E.srcCatalog],
  );

  // ── organizations: companies AND schools in ONE table (02 §1)
  const orgs: [string, string, string, string, string | null][] = [
    [E.orgSage, "company", "Sage Group plc", "Sage", "sage.com"],
    [E.orgGoogle, "company", "Google LLC", "Google", "google.com"],
    [E.orgIntacct, "company", "Intacct Inc.", "Intacct", "intacct.com"],
    [E.orgAutomattic, "company", "Automattic Inc.", "Automattic", "automattic.com"],
    [E.orgSppu, "school", "Savitribai Phule Pune University", "SPPU", "unipune.ac.in"],
    [E.orgDpu, "school", "Dr. D. Y. Patil Vidyapeeth", "DPU", "dpu.edu.in"],
  ];
  for (const [id, kind, legal, display, domain] of orgs) {
    await db.query(
      `INSERT INTO organizations (org_id, org_kind, legal_name, display_name, primary_domain,
        confidence, source_id, valid_from) VALUES ($1,$2,$3,$4,$5,0.97,$6,$7)`,
      [id, kind, legal, display, domain, E.srcProvider, T0],
    );
    if (domain) {
      await db.query(
        `INSERT INTO organization_identifiers (org_id, id_type, id_value, source_id) VALUES ($1,'domain',$2,$3)`,
        [id, domain, E.srcProvider],
      );
    }
  }
  const aliases: [string, string, string][] = [
    [E.orgSage, "Sage", "trade"],
    [E.orgSage, "Sage Group", "trade"],
    [E.orgSppu, "SPPU", "acronym"],
    [E.orgSppu, "Pune University", "former_name"],
    [E.orgDpu, "DPU", "acronym"],
  ];
  for (const [orgId, alias, kind] of aliases) {
    await db.query(
      `INSERT INTO organization_aliases (alias_id, org_id, alias, alias_kind, source_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [seedId("oal", alias), orgId, alias, kind, E.srcProvider],
    );
  }

  // ── people
  await db.query(
    `INSERT INTO persons (person_id, full_name, first_name, last_name, headline, country_code,
      current_org_id, current_title, current_function, current_seniority, confidence, valid_from)
     VALUES ($1,'Alex Mehta','Alex','Mehta','Software Engineer at Sage','IN',$2,'Software Engineer','engineering','ic',0.94,$3),
            ($4,'Siya Rao','Siya','Rao','Product Manager at Sage','IN',$2,'Product Manager','product','manager',0.94,$3)`,
    [E.pnAlex, E.orgSage, T0, E.pnSiya],
  );

  // ── Domain A: works-at
  await db.query(
    `INSERT INTO person_positions (position_id, person_id, org_id, company_name_raw, relationship_type,
      title, job_function, seniority, started_on, is_current, source_id, confidence, valid_from)
     VALUES ($1,$2,$3,'Sage','employee','Software Engineer','engineering','ic','2021-03-01',true,$4,0.90,'2021-03-01T00:00:00Z'),
            ($5,$6,$3,'Sage','employee','Product Manager','product','manager','2019-06-01',true,$4,0.90,'2019-06-01T00:00:00Z')`,
    [E.posAlexSage, E.pnAlex, E.orgSage, E.srcProvider, E.posSiyaSage, E.pnSiya],
  );

  // ── Domain B: studied-at (school orgs, same table as companies)
  await db.query(
    `INSERT INTO person_educations (education_id, person_id, org_id, school_name, relationship_type,
      degree, fields_of_study, started_year, ended_year, source_id, confidence, valid_from)
     VALUES ($1,$2,$3,'Savitribai Phule Pune University','student','B.Tech',ARRAY['Computer Science'],2015,2019,$4,0.88,$5),
            ($6,$7,$8,'Dr. D. Y. Patil Vidyapeeth','student','B.E.',ARRAY['Information Technology'],2016,2020,$4,0.88,$5)`,
    [E.eduAlexSppu, E.pnAlex, E.orgSppu, E.srcProvider, T0, E.eduSiyaDpu, E.pnSiya, E.orgDpu],
  );

  // ── technology catalog
  await db.query(
    `INSERT INTO technology_categories (category_id, name, path) VALUES
      ($1,'ERP','software.enterprise.erp'),
      ($2,'CMS','software.web.cms'),
      ($3,'Analytics','software.web.analytics')`,
    [E.catErp, E.catCms, E.catAnalytics],
  );
  const techs: [string, string, string, string, string | null][] = [
    [E.techIntacct, "Sage Intacct", "sage-intacct", "product", E.catErp],
    [E.techSage50, "Sage 50", "sage-50", "product", E.catErp],
    [E.techSageX3, "Sage X3", "sage-x3", "product", E.catErp],
    [E.techWordpress, "WordPress", "wordpress", "platform", E.catCms],
    [E.techGa, "Google Analytics", "google-analytics", "service", E.catAnalytics],
    [E.techGkp, "Google Keyword Planner", "google-keyword-planner", "service", E.catAnalytics],
  ];
  for (const [id, name, slug, kind, cat] of techs) {
    await db.query(
      `INSERT INTO technologies (technology_id, canonical_name, slug, tech_kind, category_id,
        confidence, source_id, valid_from) VALUES ($1,$2,$3,$4,$5,0.95,$6,$7)`,
      [id, name, slug, kind, cat, E.srcCatalog, T0],
    );
  }
  await db.query(
    `INSERT INTO technology_aliases (alias_id, technology_id, alias, alias_kind, source_id) VALUES
      ($3,$1,'GA4','variant',$2),
      ($4,$1,'gtag.js','detector_name',$2)`,
    [E.techGa, E.srcCatalog, seedId("tal", "GA4"), seedId("tal", "GTAGJS")],
  );

  // ── ⭐ Domain C: the develops-vs-uses split — SAME org, DIFFERENT relationship_type
  const developsRows: [string, string, string, boolean][] = [
    [E.relDevIntacct, E.orgSage, E.techIntacct, true],
    [E.relDevSage50, E.orgSage, E.techSage50, false],
    [E.relDevSageX3, E.orgSage, E.techSageX3, false],
    [E.relDevGa, E.orgGoogle, E.techGa, true],
    [E.relDevGkp, E.orgGoogle, E.techGkp, false],
    [E.relDevWordpress, E.orgAutomattic, E.techWordpress, true],
  ];
  for (const [relId, orgId, techId, primary] of developsRows) {
    await db.query(
      `INSERT INTO org_technology_relations (rel_id, org_id, technology_id, relationship_type,
        is_primary_product, source_id, confidence, valid_from) VALUES ($1,$2,$3,'develops',$4,$5,0.90,$6)`,
      [relId, orgId, techId, primary, E.srcCatalog, T0],
    );
  }
  const usesRows: [string, string, string, string, string, string][] = [
    [
      E.relUseWordpress,
      E.orgSage,
      E.techWordpress,
      "webappanalyzer",
      "2023-02-10T00:00:00Z",
      "sage.com",
    ],
    [E.relUseGa, E.orgSage, E.techGa, "webappanalyzer", "2022-11-01T00:00:00Z", "sage.com"],
    [E.relUseGkp, E.orgSage, E.techGkp, "job_posting", "2023-05-19T00:00:00Z", "careers.sage.com"],
  ];
  for (const [relId, orgId, techId, method, firstSeen, domain] of usesRows) {
    await db.query(
      `INSERT INTO org_technology_relations (rel_id, org_id, technology_id, relationship_type,
        first_seen_at, last_seen_at, detection_method, detected_on_domain, source_id, confidence, valid_from)
       VALUES ($1,$2,$3,'uses',$4,'2026-07-30T00:00:00Z',$5,$6,$7,0.88,$4)`,
      [relId, orgId, techId, firstSeen, method, domain, E.srcWeb],
    );
  }

  // ── Domain D: ownership ledger, incl. the Intacct acquisition (creator ≠ current owner)
  await db.query(
    `INSERT INTO technology_vendors (link_id, technology_id, org_id, relationship, source_id, confidence, valid_from, valid_to) VALUES
      ($10,$1,$2,'creator',$7,0.97,'2005-04-14T00:00:00Z',NULL),
      ($11,$1,$2,'current_owner',$7,0.97,'2005-04-14T00:00:00Z',NULL),
      ($12,$3,$2,'creator',$7,0.95,'2005-04-14T00:00:00Z',NULL),
      ($13,$4,$5,'creator',$7,0.93,'2003-05-27T00:00:00Z',NULL),
      ($14,$4,$5,'current_owner',$7,0.93,'2003-05-27T00:00:00Z',NULL),
      ($15,$6,$8,'creator',$7,0.96,'1999-01-01T00:00:00Z',NULL),
      ($16,$6,$8,'former_owner',$7,0.96,'1999-01-01T00:00:00Z','2017-07-28T00:00:00Z'),
      ($17,$6,$9,'current_owner',$7,0.96,'2017-07-28T00:00:00Z',NULL)`,
    [
      E.techGa,
      E.orgGoogle,
      E.techGkp,
      E.techWordpress,
      E.orgAutomattic,
      E.techIntacct,
      E.srcCatalog,
      E.orgIntacct,
      E.orgSage,
      seedId("tv", "GACREATOR"),
      seedId("tv", "GAOWNER"),
      seedId("tv", "GKPCREATOR"),
      seedId("tv", "WPCREATOR"),
      seedId("tv", "WPOWNER"),
      seedId("tv", "INTACCTCREATOR"),
      seedId("tv", "INTACCTOWNOLD"),
      seedId("tv", "INTACCTOWNNEW"),
    ],
  );

  // ── attestations: two INDEPENDENT sources on Alex's position → fused 0.910 (04 §1)
  await attest(db, E.posAlexSage, {
    sourceId: E.srcProvider,
    sourceClass: "licensed_provider",
    confidence: 0.9,
    rawAssertion: "Alex Mehta — Software Engineer, Sage",
    seenAt: new Date("2026-07-28T00:00:00Z"),
    licenseClass: "provider_b2b_resale",
  });
  await attest(db, E.posAlexSage, {
    sourceId: E.srcWeb,
    sourceClass: "web_public",
    confidence: 0.85,
    rawAssertion: "Alex Mehta | Sage | Engineering",
    seenAt: new Date("2026-03-11T00:00:00Z"),
    licenseClass: "open_web",
  });
}
