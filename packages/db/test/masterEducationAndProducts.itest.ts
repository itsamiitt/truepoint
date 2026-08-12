// masterEducationAndProducts.itest.ts — proves migration 0108 and the typed traversals it enables, against a
// real Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts).
// Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/masterEducationAndProducts.itest.ts
//
// 0108 re-plans the graph around one idea: an institution is an institution. A school is a master_companies
// row with org_kind='school', so "works at" and "studied at" traverse ONE organization catalog and differ
// only by which edge table they live in. This file proves:
//   (1) the org_kind column exists, defaults every pre-existing row to 'company', and rejects a bad kind;
//   (2) master_education records a stint, converges on re-assertion (no duplicate), and survives an
//       unresolved school via the raw/normalized-name path;
//   (3) ALUMNUS IS A DATE PREDICATE — listAlumni('completed') returns the graduate and not the enrollee,
//       with no is_alumnus column anywhere;
//   (4) DEVELOPS vs USES are disjoint over the same company — the whole point of the re-plan;
//   (5) the dead technographics column is GONE;
//   (6) the Layer-0 wall still holds for the new table: leadwolf_app cannot address master_education.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let personAlex = "";
let personSiya = "";
let orgSage = "";
let orgSppu = "";
let techIntacct = "";
let techWordpress = "";

beforeAll(async () => {
  dbHandle = await startItestDb("masterEducationAndProducts");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  // admin = privileged owner connection (Layer 0 has no app grant); app = the non-BYPASSRLS leadwolf_app
  // role the wall proof connects with.
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  // env is set above, BEFORE the db singleton loads.
  dbmod = (await import("@leadwolf/db")) as DbModule;

  // Layer-0 seed goes through the owner connection: the master tables have no app grant.
  const [sage] = await admin`
    INSERT INTO master_companies (name, primary_domain, org_kind)
    VALUES ('Sage Group plc', 'sage.com', 'company') RETURNING id`;
  orgSage = (sage as { id: string }).id;

  // A SCHOOL is the same table — that is the re-plan.
  const [sppu] = await admin`
    INSERT INTO master_companies (name, primary_domain, org_kind)
    VALUES ('Savitribai Phule Pune University', 'unipune.ac.in', 'school') RETURNING id`;
  orgSppu = (sppu as { id: string }).id;

  const [alex] =
    await admin`INSERT INTO master_persons (full_name) VALUES ('Alex Mehta') RETURNING id`;
  personAlex = (alex as { id: string }).id;
  const [siya] =
    await admin`INSERT INTO master_persons (full_name) VALUES ('Siya Rao') RETURNING id`;
  personSiya = (siya as { id: string }).id;

  const [intacct] = await admin`
    INSERT INTO master_technologies (slug, canonical_name) VALUES ('sage-intacct', 'Sage Intacct') RETURNING id`;
  techIntacct = (intacct as { id: string }).id;
  const [wp] = await admin`
    INSERT INTO master_technologies (slug, canonical_name) VALUES ('wordpress', 'WordPress') RETURNING id`;
  techWordpress = (wp as { id: string }).id;

  // Sage DEVELOPS Sage Intacct (vendor ledger) …
  await admin`
    INSERT INTO master_technology_vendors (technology_id, master_company_id, relationship, confidence)
    VALUES (${techIntacct}, ${orgSage}, 'current_owner', 0.95)`;
  // … and USES WordPress (adoption edge). Same company, different fact, different table.
  await admin`
    INSERT INTO master_technology_adoptions
      (master_company_id, technology_id, detection_method, first_seen_at, last_seen_at, observed_at, confidence)
    VALUES (${orgSage}, ${techWordpress}, 'webappanalyzer', now() - interval '90 days', now(), now(), 0.88)`;
}, 180_000);

afterAll(async () => {
  // Optional-chained so a failure during provisioning surfaces its real cause instead of a TypeError on
  // an unassigned handle (the house rule in CLAUDE.md).
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("0108 — org_kind", () => {
  test("defaults to 'company' and admits schools", async () => {
    const rows = await admin`
      SELECT org_kind FROM master_companies WHERE id = ${orgSppu}`;
    expect((rows[0] as { org_kind: string }).org_kind).toBe("school");

    // A row inserted without the column still lands as a company — the backfill contract for every
    // pre-0108 row in production.
    const [plain] = await admin`
      INSERT INTO master_companies (name) VALUES ('Nameless Co') RETURNING org_kind`;
    expect((plain as { org_kind: string }).org_kind).toBe("company");
  });

  test("rejects an unknown kind", async () => {
    let failed = "";
    try {
      await admin`INSERT INTO master_companies (name, org_kind) VALUES ('Bad Co', 'startup')`;
    } catch (err) {
      failed = String((err as { message?: string }).message ?? err);
    }
    expect(failed).toMatch(/org_kind_enum|violates check constraint/i);
  });
});

describe("0108 — master_education", () => {
  test("records a stint and converges on re-assertion instead of duplicating", async () => {
    const first = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.recordEducation(tx, {
        masterPersonId: personAlex,
        masterCompanyId: orgSppu,
        schoolNameRaw: "Savitribai Phule Pune University",
        degree: "B.Tech",
        fieldsOfStudy: ["Computer Science"],
        startedOn: "2015-08-01",
        endedOn: "2019-05-31",
        confidence: 0.88,
      }),
    );
    expect(first).toBeTruthy();

    // Same stint, seen again from another source: converge, bump source_count, do NOT duplicate.
    const second = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.recordEducation(tx, {
        masterPersonId: personAlex,
        masterCompanyId: orgSppu,
        startedOn: "2015-08-01",
        confidence: 0.8,
      }),
    );
    expect(second).toBe(first);

    const rows = await admin`
      SELECT source_count FROM master_education WHERE id = ${first as string}`;
    expect(Number((rows[0] as { source_count: number }).source_count)).toBe(2);
  });

  test("an UNRESOLVED school still records the assertion (the fact is not lost at the door)", async () => {
    const id = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.recordEducation(tx, {
        masterPersonId: personSiya,
        masterCompanyId: null,
        schoolNameRaw: "Dr. D. Y. Patil Vidyapeeth",
        schoolNameNormalized: "dr d y patil vidyapeeth",
        degree: "B.E.",
        startedOn: "2016-08-01",
        endedOn: "2020-05-31",
      }),
    );
    expect(id).toBeTruthy();

    const rows = await admin`
      SELECT master_company_id, school_name_raw FROM master_education WHERE id = ${id as string}`;
    expect((rows[0] as { master_company_id: string | null }).master_company_id).toBeNull();
    expect((rows[0] as { school_name_raw: string }).school_name_raw).toContain("Patil");
  });

  test("reads back on the person profile", async () => {
    const educations = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.listPersonEducation(tx, personAlex),
    );
    expect(educations).toHaveLength(1);
    expect(educations[0]?.schoolName).toBe("Savitribai Phule Pune University");
    expect(educations[0]?.orgKind).toBe("school");
    expect(educations[0]?.degree).toBe("B.Tech");
  });
});

describe("0108 — alumnus is a DATE PREDICATE, not a column", () => {
  test("no is_alumnus column exists", async () => {
    const cols = await admin`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'master_education' AND column_name LIKE '%alumn%'`;
    expect(cols).toHaveLength(0);
  });

  test("completed returns the graduate; current returns the still-enrolled", async () => {
    // Siya enrols at SPPU with no end date — currently studying.
    await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.recordEducation(tx, {
        masterPersonId: personSiya,
        masterCompanyId: orgSppu,
        startedOn: "2025-08-01",
        endedOn: null,
      }),
    );

    const alumni = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.listAlumni(tx, orgSppu, { status: "completed" }),
    );
    expect(alumni.map((a) => a.masterPersonId)).toEqual([personAlex]);

    const current = await dbmod.withErTx((tx) =>
      dbmod.masterEducationRepository.listAlumni(tx, orgSppu, { status: "current" }),
    );
    expect(current.map((a) => a.masterPersonId)).toEqual([personSiya]);
  });
});

describe("develops vs uses — disjoint over the same company", () => {
  test("what Sage BUILDS is its product, never its stack", async () => {
    const products = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.listCompanyProducts(tx, orgSage),
    );
    expect(products.map((p) => p.canonicalName)).toEqual(["Sage Intacct"]);
    expect(products.some((p) => p.technologyId === techWordpress)).toBe(false);
  });

  test("what Sage RUNS is its stack, never its product", async () => {
    const stack = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.listCompanyTechnologies(tx, orgSage),
    );
    expect(stack.map((t) => t.canonicalName)).toEqual(["WordPress"]);
    expect(stack.some((t) => t.technologyId === techIntacct)).toBe(false);
  });

  test("the creator expansion answers 'who built what you run'", async () => {
    // Automattic builds WordPress; Sage merely runs it.
    const [auto] = await admin`
      INSERT INTO master_companies (name, primary_domain) VALUES ('Automattic Inc.', 'automattic.com') RETURNING id`;
    await admin`
      INSERT INTO master_technology_vendors (technology_id, master_company_id, relationship)
      VALUES (${techWordpress}, ${(auto as { id: string }).id}, 'creator')`;

    const creators = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.listCreatorsForTechnologies(tx, [techWordpress]),
    );
    expect(creators.get(techWordpress)?.companyName).toBe("Automattic Inc.");
  });
});

describe("0108 — the dead blob is gone, the wall still stands", () => {
  test("master_companies.technographics no longer exists", async () => {
    const cols = await admin`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'master_companies' AND column_name = 'technographics'`;
    expect(cols).toHaveLength(0);
  });

  test("leadwolf_app cannot address master_education (grant-off wall)", async () => {
    let code = "";
    try {
      await app`SELECT 1 FROM master_education LIMIT 1`;
    } catch (err) {
      code = String((err as { code?: string }).code ?? "");
    }
    expect(code).toBe(PERMISSION_DENIED);
  });
});
