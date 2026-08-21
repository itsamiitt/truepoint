// masterCompanySearch.itest.ts — behavioural proof of the GLOBAL company search (search-consolidation
// stage 2, migration 0134): MASTER_COMPANY_VISIBLE excludes exactly what it should, the keyset is stable
// across every sort, exclude-terms keep NULL rows, the derived employee_band maps to real bounds, and the
// count is capped rather than exact. On a real Postgres (Testcontainers or ITEST_DATABASE_URL).
// Run in its OWN process — the db client is a module singleton:
//   bun test ./packages/db/test/masterCompanySearch.itest.ts
//
// The visibility assertions are the point of this file. `field_provenance <> '{}'` is the clause that
// separates a real company from a position-minted stub, and it is NOT self-evident: production had 3,747
// rows passing org_kind + domain of which only 231 carried firmographics. A regression that drops the
// clause would not fail typecheck, would not fail lint, and would look fine in review — it would just
// quietly fill the Accounts tab with blank rows. That is what test 1 pins.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

const QUERY = {
  filters: [] as never[],
  sort: "relevance" as const,
  limit: 50,
};

beforeAll(async () => {
  dbHandle = await startItestDb("master_company_search");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");

  // One VISIBLE company, plus one of each thing the predicate must exclude.
  await admin`
    INSERT INTO master_companies
      (name, name_normalized, primary_domain, org_kind, industry, employee_count, year_founded,
       ownership_type, hq_country, hq_city, specialties, field_provenance)
    VALUES
      ('Acme',    'acme',    'acme.com',    'company', 'Software', 120,  2010, 'private', 'United States', 'Austin', ARRAY['crm','saas'], '{"name":{}}'::jsonb),
      ('Globex',  'globex',  'globex.com',  'company', 'Retail',   9000, 1998, 'public',  'Germany',       'Berlin', ARRAY['retail'],     '{"name":{}}'::jsonb),
      ('NoIndustry','noindustry','noind.com','company', NULL,      50,   NULL, NULL,      NULL,            NULL,     NULL,                '{"name":{}}'::jsonb),
      ('Stub',    'stub',    'stub.com',    'company', NULL,       NULL, NULL, NULL,      NULL,            NULL,     NULL,                '{}'::jsonb),
      ('State U', 'state u', 'stateu.edu',  'school',  NULL,       NULL, NULL, NULL,      NULL,            NULL,     NULL,                '{"name":{}}'::jsonb),
      ('NoDomain','nodomain', NULL,         'company', 'Software', 10,   NULL, NULL,      NULL,            NULL,     NULL,                '{"name":{}}'::jsonb)`;
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("MASTER_COMPANY_VISIBLE", () => {
  test("1. admits only real, addressable, LANDED companies", async () => {
    const { rows } = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, QUERY),
    );
    const domains = rows.map((r) => r.primaryDomain).sort();

    // Acme, Globex and NoIndustry landed (non-empty field_provenance) and have a domain.
    expect(domains).toEqual(["acme.com", "globex.com", "noind.com"]);

    // Each exclusion, named, so a failure says WHICH clause regressed rather than just "wrong count":
    expect(domains).not.toContain("stub.com"); //   field_provenance = '{}'  → minted stub, never landed
    expect(domains).not.toContain("stateu.edu"); // org_kind = 'school'      → not a company
    // NoDomain has no primary_domain at all, so it cannot appear under any spelling.
    expect(rows.every((r) => r.primaryDomain !== null)).toBe(true);
  });

  test("2. a non-visible company is absent from a point read, not merely filtered from the list", async () => {
    // The profile route turns null into a 404, so "absent" and "not yours" are indistinguishable.
    const stub = await db.withErTx((tx) =>
      db.masterCompanyReadRepository.findByDomainTx(tx, "stub.com"),
    );
    const school = await db.withErTx((tx) =>
      db.masterCompanyReadRepository.findByDomainTx(tx, "stateu.edu"),
    );
    const real = await db.withErTx((tx) =>
      db.masterCompanyReadRepository.findByDomainTx(tx, "acme.com"),
    );
    expect(stub).toBeNull();
    expect(school).toBeNull();
    expect(real?.name).toBe("Acme");
  });

  test("3. the app role holds NO grant on master_companies (the ^master_ access-path wall)", async () => {
    const [row] = await admin`
      SELECT has_table_privilege('leadwolf_app', 'master_companies', 'SELECT') AS can_select`;
    expect((row as { can_select: boolean }).can_select).toBe(false);
  });
});

describe("filters", () => {
  test("4. an exclude term keeps rows whose column is NULL", async () => {
    // "not in Retail" must include the company with no industry recorded. A bare NOT (…) evaluates to NULL
    // for those rows and silently drops them — the COALESCE in buildWhere is what stops that.
    const { rows } = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, {
        ...QUERY,
        filters: [{ kind: "term", field: "industry", op: "exclude", values: ["Retail"] }],
      }),
    );
    const domains = rows.map((r) => r.primaryDomain).sort();
    expect(domains).toEqual(["acme.com", "noind.com"]);
  });

  test("5. employee_band is DERIVED from employee_count, not read from the dead column", async () => {
    // master_companies.employee_band has no writer and is NULL on every row here — if the repository read
    // the column instead of translating the band to bounds, this returns nothing.
    const { rows } = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, {
        ...QUERY,
        filters: [{ kind: "term", field: "employee_band", op: "include", values: ["51-200"] }],
      }),
    );
    expect(rows.map((r) => r.primaryDomain)).toEqual(["acme.com"]);
  });

  test("6. an unrecognised band matches nothing rather than widening the result set", async () => {
    const { rows } = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, {
        ...QUERY,
        filters: [{ kind: "term", field: "employee_band", op: "include", values: ["not-a-band"] }],
      }),
    );
    expect(rows).toEqual([]);
  });

  test("7. specialties uses array overlap", async () => {
    const { rows } = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, {
        ...QUERY,
        filters: [{ kind: "term", field: "specialty", op: "include", values: ["saas"] }],
      }),
    );
    expect(rows.map((r) => r.primaryDomain)).toEqual(["acme.com"]);
  });

  test("8. free text matches name OR domain, and only those", async () => {
    const byName = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, { ...QUERY, text: "glob" }),
    );
    expect(byName.rows.map((r) => r.primaryDomain)).toEqual(["globex.com"]);

    const byDomain = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, { ...QUERY, text: "noind" }),
    );
    expect(byDomain.rows.map((r) => r.primaryDomain)).toEqual(["noind.com"]);
  });
});

describe("keyset pagination", () => {
  // Every sort walked one row at a time must visit each visible company EXACTLY once. A mismatched seek
  // predicate (the classic way to break a keyset) shows up here as a duplicate or a missing row, and
  // nowhere else.
  for (const sort of ["relevance", "recently_updated", "name_asc", "headcount_desc"] as const) {
    test(`9.${sort} — a full cursor walk visits every row exactly once`, async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await db.withErTx((tx) =>
          db.masterCompanySearchRepository.searchCompaniesTx(tx, {
            ...QUERY,
            sort,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          }),
        );
        seen.push(...res.rows.map((r) => r.primaryDomain));
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      expect(seen.sort()).toEqual(["acme.com", "globex.com", "noind.com"]);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
    });
  }

  test("10. a mangled cursor degrades to the first page instead of throwing", async () => {
    const res = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.searchCompaniesTx(tx, {
        ...QUERY,
        cursor: "not-base64url!!",
      }),
    );
    expect(res.rows).toHaveLength(3);
  });
});

describe("count", () => {
  test("11. reports the exact total below the cap, and says so", async () => {
    const res = await db.withErTx((tx) =>
      db.masterCompanySearchRepository.countCompaniesTx(tx, QUERY),
    );
    expect(res).toEqual({ total: 3, capped: false });
  });

  test("12. counts the same population the search returns", async () => {
    const filters = [
      {
        kind: "term" as const,
        field: "industry" as const,
        op: "include" as const,
        values: ["Software"],
      },
    ];
    const [page, count] = await Promise.all([
      db.withErTx((tx) =>
        db.masterCompanySearchRepository.searchCompaniesTx(tx, { ...QUERY, filters }),
      ),
      db.withErTx((tx) =>
        db.masterCompanySearchRepository.countCompaniesTx(tx, { ...QUERY, filters }),
      ),
    ]);
    expect(count.total).toBe(page.rows.length);
  });
});
