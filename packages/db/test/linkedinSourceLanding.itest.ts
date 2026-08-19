// linkedinSourceLanding.itest.ts — behavioural proof of the linkedin_api Layer-0 landing
// (core landLinkedinPayload; docs/planning/linkedin-source-ingestion/). On a real Postgres
// (Testcontainers or ITEST_DATABASE_URL). Run in its OWN process:
//   bun test ./packages/db/test/linkedinSourceLanding.itest.ts
//
// Proofs:
//   1. PERSON E2E — a sample-shaped payload lands: profile scalars via the fold, identifier rows (slug/urn/
//      member id), one master_employment row per position with partial-date precision, the primary edge,
//      education with the school minted org_kind='school', ONE source_records row, provenance events, and
//      current_company_id pointing at the primary employer.
//   2. IDEMPOTENT REPLAY — the same payload again: reason 'duplicate', NO new events, source_count stays 1.
//   3. PIN BLOCKS THE PROVIDER — a pinned headline survives a re-land of a modified payload while unpinned
//      fields update (the planFieldWrite discipline, proven through the whole landing).
//   4. JOB CHANGE — a later payload with a NEW current employer flips the primary edge demote-then-promote
//      and emits ONE job_change master_signals row (S-13/S-09).
//   5. SUPPRESSED PERSON — evidence row only; zero facts, zero edges, zero signals.
//   6. COMPANY E2E — firmographics + structured revenue + HQ + headcount series + identifiers land;
//      replaying converges (no duplicate headcount rows).
//
// DB error capture uses try/catch, NEVER expect(...).rejects (the pooled-connection hang trap).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

// Relative source-barrel import, NOT a @leadwolf/core devDep: a db→core devDependency creates a Turbo
// ^build cycle that breaks typecheck (the established cross-package test-import rule in this repo).
type CoreModule = typeof import("../../core/src/index.ts");
type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: CoreModule;
let dbmod: DbModule;

const PERSON_V1 = {
  schema_version: 1,
  profile_id: "ACwAAA_itest_urn_1",
  member_id: 151823172,
  public_identifier: "itest-william-gates",
  linkedin_url: "https://www.linkedin.com/in/itest-william-gates",
  first_name: "William",
  last_name: "Gates",
  full_name: "William Gates",
  pronoun: null,
  headline: "VP of Finance",
  summary: "Finance leader.",
  location: "Fort Lauderdale, Florida, United States",
  premium: false,
  open_link: false,
  job_seeker: false,
  current_position: {
    title: "Senior Director of Accounting",
    company_name: "Vertical Bridge",
    company_id: 9338128,
    is_current: true,
    start_date: "2026-05",
    end_date: null,
  },
  positions: [
    {
      title: "Senior Director of Accounting",
      company_name: "Vertical Bridge",
      company_id: 9338128,
      is_current: true,
      start_date: "2026-05",
      end_date: null,
    },
    {
      title: "VP of Finance",
      company_name: "Sage Dental",
      company_id: 2844769,
      is_current: false,
      start_date: "2025-05",
      end_date: "2026-05",
    },
    {
      title: "Financial Reporting Manager",
      company_name: "Unified Womens Healthcare",
      company_id: 14806044,
      is_current: false,
      start_date: "2018",
      end_date: "2022-01",
    },
  ],
  educations: [
    {
      school_name: "Florida Atlantic University",
      school_id: 9077,
      degree: "Master of Accounting",
      fields_of_study: ["Accounting"],
      start_date: "2010",
      end_date: "2011",
    },
  ],
  skills: ["Accounting", "GAAP", "accounting"], // case-dupe collapses to 2 rows
  languages: [
    { name: "English", proficiency: "PROFESSIONAL_WORKING" },
    { name: "Hindi", proficiency: "NATIVE_OR_BILINGUAL" },
  ],
  volunteering: [],
  contact: {
    primary_email: "Itest.WG@Itest-VB.example",
    emails: [{ email: "wg.home@itest-mail.example", type: "personal" }],
    phones: ["+1 415 555 0100", { number: "+91 98765 43210", type: "mobile" }],
  },
};

// v2: same person, NEW current employer (job change) + a changed headline (fold update path).
const PERSON_V2 = {
  ...PERSON_V1,
  headline: "Senior Director of Accounting at NewCo",
  current_position: {
    title: "Head of Finance",
    company_name: "NewCo Industries",
    company_id: 777001,
    is_current: true,
    start_date: "2026-07",
    end_date: null,
  },
  positions: [
    {
      title: "Head of Finance",
      company_name: "NewCo Industries",
      company_id: 777001,
      is_current: true,
      start_date: "2026-07",
      end_date: null,
    },
    ...PERSON_V1.positions.map((p) => ({ ...p, is_current: false })),
  ],
};

const SUPPRESSED_PERSON = {
  ...PERSON_V1,
  profile_id: "ACwAAA_itest_urn_suppressed",
  member_id: 999000111,
  public_identifier: "itest-suppressed-person",
  positions: PERSON_V1.positions.slice(0, 1),
  educations: [],
};

const COMPANY = {
  schema_version: 2,
  company_id: 2619,
  entity_urn: "urn:li:fs_salesCompany:2619",
  public_identifier: "itest-anthem",
  name: "Anthem, Inc.",
  description: "Anthem, Inc. is now Elevance Health.",
  industry: "Hospitals and Health Care",
  type: "Public Company",
  specialties: [],
  website: "www.itest-elevance.com",
  location: "Indianapolis, Indiana, United States",
  headquarters: {
    line1: "220 Virginia Ave",
    line2: null,
    city: "Indianapolis",
    geographic_area: "Indiana",
    postal_code: "46203",
    country: "United States",
  },
  year_founded: 1946,
  revenue_range: {
    currency: "USD",
    min: { amount: 5, unit: "MILLION" },
    max: { amount: 10, unit: "MILLION" },
  },
  employee_count: 18287,
  headcount: {
    total: 18287,
    as_of: "2026-08",
    monthly: [
      { month: "2026-05", count: 18262 },
      { month: "2026-06", count: 18269 },
      { month: "2026-07", count: 18282 },
      { month: "2026-08", count: 18287 },
    ],
    by_function: [],
  },
};

beforeAll(async () => {
  dbHandle = await startItestDb("linkedinSourceLanding");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  // The landing gates — set BEFORE @leadwolf/config loads via the dynamic imports below.
  process.env.LINKEDIN_SOURCE_LANDING_ENABLED = "true";
  process.env.PROVENANCE_EVENTS_ENABLED = "true";
  process.env.LINKEDIN_SIGNALS_ENABLED = "true";
  process.env.LINKEDIN_CHANNELS_ENABLED = "true"; // multi-value typed email/phone contribution (0116)

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("linkedin_api Layer-0 landing (landLinkedinPayload)", () => {
  let personId = "";

  test("1. person payload lands end-to-end: scalars, identifiers, stints, primary, education, evidence, events", async () => {
    const result = await core.landLinkedinPayload({ payload: PERSON_V1, fetchedAt: new Date() });
    expect(result.landed).toBe(true);
    expect(result.reason).toBe("landed");
    personId = result.masterPersonId ?? "";
    expect(personId).not.toBe("");

    const [person] = await admin`
      SELECT full_name, headline, summary, location_raw, job_title, current_company_id, linkedin_public_id
        FROM master_persons WHERE id = ${personId}`;
    expect(person!.headline).toBe("VP of Finance");
    expect(person!.summary).toBe("Finance leader.");
    expect(person!.location_raw).toBe("Fort Lauderdale, Florida, United States");
    expect(person!.job_title).toBe("Senior Director of Accounting");
    expect(person!.linkedin_public_id).toBe("itest-william-gates");
    expect(person!.current_company_id).not.toBeNull();

    const idents = await admin`
      SELECT id_type FROM master_person_identifiers WHERE master_person_id = ${personId} ORDER BY id_type`;
    expect(idents.map((r) => r.id_type)).toEqual([
      "linkedin_member_id",
      "linkedin_member_urn",
      "linkedin_public_id",
    ]);

    const stints = await admin`
      SELECT title, is_current, is_primary, started_on::text AS started_on, start_precision
        FROM master_employment WHERE master_person_id = ${personId} ORDER BY started_on`;
    expect(stints).toHaveLength(3);
    // "2018" → year precision, Jan 1; "2026-05" → month precision.
    expect(stints[0]!.started_on).toBe("2018-01-01");
    expect(stints[0]!.start_precision).toBe("year");
    const primary = stints.filter((s) => s.is_primary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.title).toBe("Senior Director of Accounting");

    // Every position employer resolved by the domainless linkedin-id mint — zero unresolved stints.
    const [unresolved] = await admin`
      SELECT count(*)::int AS n FROM master_employment
       WHERE master_person_id = ${personId} AND master_company_id IS NULL`;
    expect(unresolved!.n).toBe(0);

    const edu = await admin`
      SELECT e.degree, e.start_precision, c.org_kind
        FROM master_education e JOIN master_companies c ON c.id = e.master_company_id
       WHERE e.master_person_id = ${personId}`;
    expect(edu).toHaveLength(1);
    expect(edu[0]!.degree).toBe("Master of Accounting");
    expect(edu[0]!.org_kind).toBe("school"); // the school mint, not a company mint
    expect(edu[0]!.start_precision).toBe("year");

    const [ev] = await admin`
      SELECT count(*)::int AS n FROM source_records
       WHERE source_name = 'linkedin_api' AND resolved_person_id = ${personId}`;
    expect(ev!.n).toBe(1);
    const [events] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE entity_id = ${personId}`;
    expect(events!.n).toBeGreaterThan(0);

    // Multi-value attributes (0116, C6 gate opened): skills case-deduped, languages with proficiency.
    const skills = await admin`
      SELECT skill FROM master_person_skills WHERE master_person_id = ${personId} ORDER BY skill`;
    expect(skills.map((r) => r.skill)).toEqual(["Accounting", "GAAP"]);
    const langs = await admin`
      SELECT name, proficiency FROM master_person_languages
       WHERE master_person_id = ${personId} ORDER BY name`;
    expect(langs.map((r) => `${r.name}:${r.proficiency}`)).toEqual([
      "English:PROFESSIONAL_WORKING",
      "Hindi:NATIVE_OR_BILINGUAL",
    ]);

    // Multi-value TYPED channels (0116, LINKEDIN_CHANNELS_ENABLED): two emails (primary + typed personal,
    // encrypted, typed), two phones (E.164-deduped, line-typed), facets raised.
    const emails = await admin`
      SELECT email_domain, email_type, is_primary,
             (email_enc IS NOT NULL) AS has_enc
        FROM master_emails WHERE master_person_id = ${personId} ORDER BY is_primary DESC, email_domain`;
    expect(
      emails.map((r) => `${r.email_domain}|${r.email_type}|${r.is_primary}|${r.has_enc}`),
    ).toEqual(["itest-vb.example|null|true|true", "itest-mail.example|personal|false|true"]);
    const phones = await admin`
      SELECT line_type, (phone_enc IS NOT NULL) AS has_enc
        FROM master_phones WHERE master_person_id = ${personId} ORDER BY line_type NULLS FIRST`;
    expect(phones.map((r) => `${r.line_type}|${r.has_enc}`)).toEqual(["null|true", "mobile|true"]);
    const [facets] = await admin`
      SELECT has_email, has_phone FROM master_persons WHERE id = ${personId}`;
    expect(facets).toEqual({ has_email: true, has_phone: true });
  });

  test("2. idempotent replay: duplicate, no new events, corroboration NOT double-counted", async () => {
    const [eventsBefore] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE entity_id = ${personId}`;
    const [stintBefore] = await admin`
      SELECT source_count FROM master_employment
       WHERE master_person_id = ${personId} AND is_primary`;

    const replay = await core.landLinkedinPayload({ payload: PERSON_V1, fetchedAt: new Date() });
    expect(replay.landed).toBe(false);
    expect(replay.reason).toBe("duplicate");
    expect(replay.masterPersonId).toBe(personId);

    const [eventsAfter] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE entity_id = ${personId}`;
    expect(eventsAfter!.n).toBe(eventsBefore!.n);
    const [stintAfter] = await admin`
      SELECT source_count FROM master_employment
       WHERE master_person_id = ${personId} AND is_primary`;
    expect(stintAfter!.source_count).toBe(stintBefore!.source_count);
    // Corroboration counters on multi-value rows are also replay-proof.
    const [skillAfter] = await admin`
      SELECT source_count FROM master_person_skills
       WHERE master_person_id = ${personId} AND skill = 'GAAP'`;
    expect(skillAfter!.source_count).toBe(1);
    const [emailCount] = await admin`
      SELECT count(*)::int AS n FROM master_emails WHERE master_person_id = ${personId}`;
    expect(emailCount!.n).toBe(2);
  });

  test("3+4. pinned field survives a re-land; new employer flips primary + emits job_change", async () => {
    // A human pinned the headline — the provider must not overwrite it (the sacrosanct-correction rule).
    await admin`
      UPDATE master_persons
         SET headline = 'Hand-corrected headline',
             field_provenance = jsonb_set(field_provenance, '{headline}',
               '{"src":"user_edit","pin":true,"by":"itest-user","at":"2026-08-01T00:00:00.000Z"}'::jsonb)
       WHERE id = ${personId}`;

    const result = await core.landLinkedinPayload({ payload: PERSON_V2, fetchedAt: new Date() });
    expect(result.landed).toBe(true);
    expect(result.masterPersonId).toBe(personId);

    const [person] = await admin`
      SELECT headline, current_company_id FROM master_persons WHERE id = ${personId}`;
    expect(person!.headline).toBe("Hand-corrected headline"); // pin held

    // Primary flipped to NewCo (linkedin id 777001), old primary demoted + closed.
    const [newPrimary] = await admin`
      SELECT e.title, c.linkedin_company_id
        FROM master_employment e JOIN master_companies c ON c.id = e.master_company_id
       WHERE e.master_person_id = ${personId} AND e.is_primary`;
    expect(newPrimary!.title).toBe("Head of Finance");
    expect(newPrimary!.linkedin_company_id).toBe("777001");
    expect(person!.current_company_id).not.toBeNull();
    const [demoted] = await admin`
      SELECT is_current, ended_on FROM master_employment e
        JOIN master_companies c ON c.id = e.master_company_id
       WHERE e.master_person_id = ${personId} AND c.linkedin_company_id = '9338128'`;
    expect(demoted!.is_current).toBe(false);
    expect(demoted!.ended_on).not.toBeNull();

    const signals = await admin`
      SELECT type_code, related_company_id FROM master_signals
       WHERE subject_type = 'person' AND subject_id = ${personId} AND type_code = 'job_change'`;
    expect(signals).toHaveLength(1);

    // Leadership signals on the same transition: "Head of Finance" infers vp ⇒ exec_hired on the NEW
    // company (company-subject — the row a watchlist watches), payload references the person by id only.
    // The OLD title ("Senior Director of Accounting") infers director ⇒ NO exec_departed anywhere.
    const [newCo] = await admin`
      SELECT id FROM master_companies WHERE linkedin_company_id = '777001'`;
    const hired = await admin`
      SELECT payload FROM master_signals
       WHERE subject_type = 'company' AND subject_id = ${newCo!.id} AND type_code = 'exec_hired'`;
    expect(hired).toHaveLength(1);
    expect(hired[0]!.payload.masterPersonId).toBe(personId);
    expect(hired[0]!.payload.seniority).toBe("vp");
    const [departed] = await admin`
      SELECT count(*)::int AS n FROM master_signals WHERE type_code = 'exec_departed'`;
    expect(departed!.n).toBe(0);
  });

  test("5. suppressed person: evidence row only — zero facts, edges, identifiers, signals", async () => {
    // Land once to mint, then suppress, then land a MODIFIED payload (new content hash).
    const first = await core.landLinkedinPayload({
      payload: SUPPRESSED_PERSON,
      fetchedAt: new Date(),
    });
    const suppressedId = first.masterPersonId ?? "";
    expect(suppressedId).not.toBe("");
    await admin`UPDATE master_persons SET is_suppressed = true, headline = NULL WHERE id = ${suppressedId}`;

    const modified = { ...SUPPRESSED_PERSON, headline: "Should never land" };
    const result = await core.landLinkedinPayload({ payload: modified, fetchedAt: new Date() });
    expect(result.landed).toBe(false);
    expect(result.reason).toBe("suppressed");

    const [person] = await admin`SELECT headline FROM master_persons WHERE id = ${suppressedId}`;
    expect(person!.headline).toBeNull(); // nothing structured landed
    const [ev] = await admin`
      SELECT count(*)::int AS n FROM source_records
       WHERE source_name = 'linkedin_api' AND resolved_person_id = ${suppressedId}`;
    expect(ev!.n).toBe(2); // both payloads retained as evidence — the objection stops FACTS, not the log
  });

  test("6. company payload lands: firmographics, revenue triple, HQ, headcount series, identifiers; replay converges", async () => {
    const result = await core.landLinkedinPayload({ payload: COMPANY, fetchedAt: new Date() });
    expect(result.landed).toBe(true);
    const companyId = result.masterCompanyId ?? "";
    expect(companyId).not.toBe("");

    const [company] = await admin`
      SELECT name, description, ownership_type, year_founded, website_url,
             revenue_min_minor, revenue_max_minor, revenue_currency, revenue_range,
             primary_domain, linkedin_company_id, hq_country, hq_city, industry, industry_id
        FROM master_companies WHERE id = ${companyId}`;
    // MI-S3: the vendor spelling stays raw; the CANONICAL node is resolved via the alias table at landing
    // ("Hospitals and Health Care" → providers-hospitals).
    expect(company!.industry).toBe("Hospitals and Health Care");
    const [node] = await admin`
      SELECT code FROM master_industries WHERE id = ${company!.industry_id}`;
    expect(node!.code).toBe("providers-hospitals");
    expect(company!.ownership_type).toBe("public");
    expect(company!.year_founded).toBe(1946);
    expect(Number(company!.revenue_min_minor)).toBe(500_000_000);
    expect(Number(company!.revenue_max_minor)).toBe(1_000_000_000);
    expect(company!.revenue_currency).toBe("USD");
    expect(company!.revenue_range).toBe("$5M–$10M");
    expect(company!.primary_domain).toBe("itest-elevance.com");
    expect(company!.linkedin_company_id).toBe("2619");
    expect(company!.hq_city).toBe("Indianapolis");

    const [hq] = await admin`
      SELECT address_line, postal_code FROM master_company_locations
       WHERE master_company_id = ${companyId} AND kind = 'hq'`;
    expect(hq!.address_line).toBe("220 Virginia Ave");
    expect(hq!.postal_code).toBe("46203");

    const series = await admin`
      SELECT month::text AS month, employee_count FROM master_company_headcount
       WHERE master_company_id = ${companyId} AND job_function = '' ORDER BY month`;
    expect(series).toHaveLength(4);
    expect(series[0]).toEqual({ month: "2026-05-01", employee_count: 18262 });
    expect(series[3]).toEqual({ month: "2026-08-01", employee_count: 18287 });

    const idents = await admin`
      SELECT id_type, id_value FROM master_company_identifiers
       WHERE master_company_id = ${companyId} ORDER BY id_type`;
    expect(idents.map((r) => `${r.id_type}=${r.id_value}`)).toEqual([
      "linkedin_company_id=2619",
      "linkedin_company_slug=itest-anthem",
    ]);

    // Replay: duplicate, and the series does NOT grow.
    const replay = await core.landLinkedinPayload({ payload: COMPANY, fetchedAt: new Date() });
    expect(replay.reason).toBe("duplicate");
    const [count] = await admin`
      SELECT count(*)::int AS n FROM master_company_headcount WHERE master_company_id = ${companyId}`;
    expect(count!.n).toBe(4);
  });
});
