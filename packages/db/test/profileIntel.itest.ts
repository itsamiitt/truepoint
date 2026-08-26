// profileIntel.itest.ts — behavioural proof of `readProfileIntel`, the ONE read behind the extension's
// Profile Intelligence Panel. Testcontainers Postgres by default, or ITEST_DATABASE_URL (see itestDb.ts).
// Named *.itest.ts so default `bun test` skips it; run in its OWN process — the db client is a module
// singleton:  bun test ./packages/db/test/profileIntel.itest.ts
//
// The four properties that would ship broken and still look fine:
//
//   1. NOTHING CONFIDENTIAL ON THE AGGREGATE. The panel renders a lot at once, which is exactly when a
//      channel value or a Layer-0 uuid slips onto a payload nobody re-reads. Test 5 deep-scans the whole
//      serialized response for an email, an E.164 number, the master uuids and the numeric LinkedIn id.
//   2. SUPPRESSION IS INDISTINGUISHABLE FROM ABSENCE. A suppressed person must answer exactly like one who
//      was never in the database — same status, same nulls (test 4).
//   3. WORKSPACE ISOLATION. `status: "found"` and the `contact` block belong to the CALLING workspace only;
//      a second workspace viewing the same profile sees `in_database` and no contact row (test 3).
//   4. THE COMPANY BLOCK IS REACHABLE FROM A COMPANY PAGE. A `/company/<slug>` URL carries no domain, so the
//      identifier hop (0113) is the only way there; test 6 pins it, and test 7 pins the Sales-Nav registry
//      hop for a numeric-id URL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: typeof import("@leadwolf/db");
let core: Core;

let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let personId = "";
let companyId = "";
let contactIdA = "";

const SLUG = "jane-visible";
const PRIVATE_SLUG = "pat-private";
const COMPANY_SLUG = "acme-inc";
const COMPANY_DOMAIN = "acme.example";
const SALESNAV_COMPANY_URL = "https://www.linkedin.com/sales/company/99887766";
/** Fabricated, RFC-2606-safe. Real vendor samples are PII and never become fixtures. */
const CONTACT_EMAIL = "jane@acme.example";
const CONTACT_PHONE = "+15550000123";

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("profileintel");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");

  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  // A visible company with real firmographics. `field_provenance <> '{}'` is load-bearing: it is what
  // MASTER_COMPANY_VISIBLE uses to tell a landed company from a minted stub.
  const [co] = await admin`
    INSERT INTO master_companies
      (name, name_normalized, primary_domain, org_kind, industry, description, year_founded,
       employee_count, ownership_type, revenue_range, hq_city, hq_country, specialties,
       linkedin_company_id, field_provenance)
    VALUES ('Acme Inc', 'acme inc', ${COMPANY_DOMAIN}, 'company', 'Software Development',
            'An accounting platform.', 2021, 209, 'private', '$1M–$2.5M', 'San Francisco',
            'United States', ARRAY['Accounting','ERP']::text[], '99887766', '{"name":{}}'::jsonb)
    RETURNING id`;
  companyId = (co as { id: string }).id;
  // The slug identifier (0113) — the ONLY hop from a /company/<slug> page to a domain.
  await admin`
    INSERT INTO master_company_identifiers (master_company_id, id_type, id_value)
    VALUES (${companyId}, 'linkedin_company_slug', ${COMPANY_SLUG})`;
  // 25 monthly headcount points — the series the panel derives its growth windows from (never stored).
  for (let i = 0; i < 25; i++) {
    const month = `${2024 + Math.floor((7 + i) / 12)}-${String(((7 + i) % 12) + 1).padStart(2, "0")}-01`;
    await admin`
      INSERT INTO master_company_headcount
        (master_company_id, month, job_function, employee_count, source_name, observed_at)
      VALUES (${companyId}, ${month}::date, '', ${24 + i * 8}, 'linkedin_api', now())`;
  }

  const [p] = await admin`
    INSERT INTO master_persons
      (linkedin_public_id, full_name, first_name, last_name, headline, job_title, location_raw,
       visibility, current_company_id, has_email, has_phone)
    VALUES (${SLUG}, 'Jane Visible', 'Jane', 'Visible', 'Head of Finance', 'Head of Finance',
            'San Francisco', 'licensed', ${companyId}, true, true)
    RETURNING id`;
  personId = (p as { id: string }).id;
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, company_name_raw, company_name_normalized,
       title, is_current, is_primary, started_on, start_precision)
    VALUES (${personId}, ${companyId}, 'Acme Inc', 'acme inc', 'Head of Finance', true, true,
            '2024-06-01', 'month')`;
  await admin`
    INSERT INTO master_education (master_person_id, school_name_raw, school_name_normalized, degree)
    VALUES (${personId}, 'Chicago Booth', 'chicago booth', 'MBA')`;
  await admin`
    INSERT INTO master_person_skills (master_person_id, skill, source_count)
    VALUES (${personId}, 'Accounting', 4), (${personId}, 'Forecasting', 2)`;
  // Channel rows exist so test 5 proves the aggregate carries the PRESENCE bits and not the values.
  await admin`
    INSERT INTO master_emails (master_person_id, email_enc, email_blind_index, email_type)
    VALUES (${personId}, ${Buffer.from(CONTACT_EMAIL)}, '\\x11'::bytea, 'work')`;
  await admin`
    INSERT INTO master_phones (master_person_id, phone_enc, phone_blind_index, line_type)
    VALUES (${personId}, ${Buffer.from(CONTACT_PHONE)}, '\\x12'::bytea, 'mobile')`;

  // A private person with a full history — the suppression/visibility probe (test 4).
  await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES (${PRIVATE_SLUG}, 'Pat Private', 'private')`;

  // The Sales-Nav company URL, already fetched and resolved — the registry hop (test 7).
  await admin`
    INSERT INTO source_fetch_registry
      (entity_kind, normalized_url, external_id, source_name, last_fetched_at, last_outcome, resolved_company_id)
    VALUES ('company', ${SALESNAV_COMPANY_URL}, '99887766', 'linkedin_api', now(), 'ok', ${companyId})`;

  // Workspace A materializes the person — the `found` branch. Workspace B deliberately does NOT.
  const added = await core.materializeContactFromMaster(
    { tenantId: tenantA, workspaceId: wsA, capturedByUserId: null },
    { linkedinPublicId: SLUG },
  );
  contactIdA = added.contactId ?? "";
  expect(contactIdA).not.toBe("");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });
const profileUrl = (slug: string) => `https://www.linkedin.com/in/${slug}`;

describe("readProfileIntel — person", () => {
  test("1. composes identity + history + company for a workspace-held person", async () => {
    const r = await core.readProfileIntel(scopeA(), profileUrl(SLUG));

    expect(r.kind).toBe("person");
    expect(r.status).toBe("found");
    expect(r.contactId).toBe(contactIdA);
    expect(r.person?.linkedinPublicId).toBe(SLUG);
    expect(r.person?.fullName).toBe("Jane Visible");
    expect(r.contact?.id).toBe(contactIdA);

    // The history blocks the Prospect tab renders.
    expect(r.profile?.employment[0]?.title).toBe("Head of Finance");
    expect(r.profile?.employment[0]?.startedOn).toBe("2024-06-01");
    expect(r.profile?.employment[0]?.startPrecision).toBe("month");
    expect(r.profile?.education[0]?.degree).toBe("MBA");
    // Most-corroborated first — the order the chips render in.
    expect(r.profile?.skills).toEqual(["Accounting", "Forecasting"]);
    expect(r.profile?.hasMobile).toBe(true);
  });

  test("2. carries the employer's company block, series oldest-first, growth NOT stored", async () => {
    const r = await core.readProfileIntel(scopeA(), profileUrl(SLUG));

    expect(r.company?.company.primaryDomain).toBe(COMPANY_DOMAIN);
    expect(r.company?.company.employeeCount).toBe(209);
    expect(r.company?.headcountSeries).toHaveLength(25);

    // Oldest-first is the contract the sparkline draws left-to-right against; a reversed series would render
    // a growing company as a shrinking one and nothing would throw.
    const months = r.company?.headcountSeries.map((p) => p.month) ?? [];
    expect([...months].sort()).toEqual(months);
    expect(r.company?.headcountSeries[0]?.employeeCount).toBe(24);
    expect(r.company?.headcountSeries.at(-1)?.employeeCount).toBe(24 + 24 * 8);

    // The no-rollup rule: growth windows are derived by the client, never a field on the payload.
    expect(r.company as unknown as Record<string, unknown>).not.toHaveProperty("growth");
  });

  test("3. workspace isolation — B sees the database person, never A's contact", async () => {
    const a = await core.readProfileIntel(scopeA(), profileUrl(SLUG));
    const b = await core.readProfileIntel(scopeB(), profileUrl(SLUG));

    expect(a.status).toBe("found");
    expect(b.status).toBe("in_database");
    expect(b.contactId).toBeNull();
    expect(b.contact).toBeNull();
    expect(b.signals).toEqual([]);
    // The licensed identity is the same for both — that is the product; the OVERLAY is what differs.
    expect(b.person?.linkedinPublicId).toBe(a.person?.linkedinPublicId);
    expect(b.person?.inWorkspace).toBeNull();
  });

  test("4. private/suppressed answers exactly like absent", async () => {
    const priv = await core.readProfileIntel(scopeA(), profileUrl(PRIVATE_SLUG));
    const absent = await core.readProfileIntel(scopeA(), profileUrl("nobody-here-at-all"));

    expect(priv).toEqual(absent);
    expect(priv.status).toBe("not_found");
    expect(priv.person).toBeNull();
    expect(priv.profile).toBeNull();

    // Suppressing a VISIBLE person must have the same effect — the erasure path the panel inherits.
    await admin`UPDATE master_persons SET is_suppressed = true WHERE id = ${personId}`;
    try {
      const suppressed = await core.readProfileIntel(scopeB(), profileUrl(SLUG));
      expect(suppressed.status).toBe("not_found");
      expect(suppressed.person).toBeNull();
      expect(suppressed.company).toBeNull();
    } finally {
      await admin`UPDATE master_persons SET is_suppressed = false WHERE id = ${personId}`;
    }
  });

  test("5. no channel value, no Layer-0 id, no numeric LinkedIn id anywhere in the payload", async () => {
    const r = await core.readProfileIntel(scopeA(), profileUrl(SLUG));
    const wire = JSON.stringify(r);

    // Presence bits, yes. Values, never — those are the paid product and live behind reveal.
    expect(r.person?.hasEmail).toBe(true);
    expect(r.person?.hasPhone).toBe(true);
    expect(wire).not.toContain(CONTACT_EMAIL);
    expect(wire).not.toContain(CONTACT_PHONE);
    expect(wire).not.toContain("@acme.example");

    // Layer-0 uuids are the caller's-side join keys; they never cross the API boundary.
    expect(wire).not.toContain(personId);
    expect(wire).not.toContain(companyId);

    // Numeric LinkedIn ids are INTERNAL link metadata (linkedin-source-ingestion README §3). The company's
    // public URL is rebuilt from the id server-side, so the URL may appear — the bare id must not.
    expect(wire).not.toMatch(/"linkedinCompanyId"/);
    expect(wire).not.toMatch(/"memberId"/);
  });
});

describe("readProfileIntel — company page", () => {
  test("6. resolves /company/<slug> through the identifier hop", async () => {
    const url = `https://www.linkedin.com/company/${COMPANY_SLUG}`;
    const r = await core.readProfileIntel(scopeA(), url);

    expect(r.kind).toBe("company");
    expect(r.company?.company.name).toBe("Acme Inc");
    expect(r.company?.headcountSeries).toHaveLength(25);
    // A company page has no person and no contact — the Prospect tab renders its empty state.
    expect(r.person).toBeNull();
    expect(r.contactId).toBeNull();
    expect(r.profile).toBeNull();

    // Workspace A holds an ACCOUNT for this domain — materializing the person in beforeAll created it as the
    // employer link — so the company reads as `found`. That is the company twin of a person's contactId:
    // the footer can say "linked" only because this workspace actually holds the account.
    expect(r.status).toBe("found");
    expect(r.company?.company.inWorkspace).not.toBeNull();

    // Workspace B holds no account for the same domain: same licensed company, no overlay fact.
    const b = await core.readProfileIntel(scopeB(), url);
    expect(b.status).toBe("in_database");
    expect(b.company?.company.inWorkspace).toBeNull();
    expect(b.company?.company.name).toBe("Acme Inc");
  });

  test("7. resolves a Sales-Nav company URL through the fetch registry", async () => {
    const r = await core.readProfileIntel(scopeA(), SALESNAV_COMPANY_URL);
    expect(r.kind).toBe("company");
    expect(r.company?.company.primaryDomain).toBe(COMPANY_DOMAIN);
  });

  test("8. an unknown company slug is a clean miss, not an error", async () => {
    const r = await core.readProfileIntel(scopeA(), "https://www.linkedin.com/company/no-such-co");
    expect(r.kind).toBe("company");
    expect(r.status).toBe("not_found");
    expect(r.company).toBeNull();
  });
});

describe("readProfileIntel — addressing", () => {
  test("9. a non-person/company URL is not_supported and reads nothing", async () => {
    for (const url of [
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/sales/search/people?query=x",
      "https://example.com/in/jane-visible",
    ]) {
      const r = await core.readProfileIntel(scopeA(), url);
      expect(r.kind).toBe("not_supported");
      expect(r.status).toBe("not_supported");
      expect(r.person).toBeNull();
      expect(r.company).toBeNull();
    }
  });
});
