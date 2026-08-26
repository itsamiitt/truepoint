// databasePeopleFilters.itest.ts — behavioural proof of the JOIN-BACKED people filters (phase 3d):
// skill, language, school, field of study, and "has ever worked at X".
// On a real Postgres (Testcontainers or ITEST_DATABASE_URL). Run in its OWN process — the db client is a
// module singleton:
//   bun test ./packages/db/test/databasePeopleFilters.itest.ts
//
// Three properties here are the ones that would ship broken and look fine:
//
//   1. PAST STINTS COUNT. `past_company` is the whole point of the filter — "ex-Stripe people". The obvious
//      implementation reads master_persons.current_company_id and silently answers "people at Stripe NOW".
//      Tests 5 and 6 pin that a purely past employer matches and that both storage shapes (a resolved
//      company id, and an unresolved normalized name) are covered — the live import path writes the first
//      with no name at all, so a name-only match would miss most of the graph.
//
//   2. VISIBILITY ON A JOIN. It is easy to gate the person query and forget that an EXISTS over an edge
//      table reintroduces rows through the join. Test 8 pins that a private person is unreachable through
//      every one of these filters.
//
//   3. EXCLUDE MUST NOT EAT THE NULLS. "not skilled in Go" has to include people with no skills recorded
//      at all. Test 7 pins it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

/** Run one term filter and return the slugs it matched. */
async function slugsFor(
  field: string,
  values: string[],
  op: "include" | "exclude" = "include",
): Promise<string[]> {
  const page = await db.withErTx((tx) =>
    db.masterPersonSearchRepository.searchPersonsTx(tx, {
      filters: [{ kind: "term", field, op, values }],
      limit: 50,
    } as never),
  );
  return page.rows.map((r) => r.linkedinPublicId).sort();
}

beforeAll(async () => {
  dbHandle = await startItestDb("database_people_filters");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");

  const [stripe] = await admin`
    INSERT INTO master_companies (name, name_normalized, primary_domain, org_kind, field_provenance)
    VALUES ('Stripe', 'stripe', 'stripe.com', 'company', '{"name":{}}'::jsonb) RETURNING id`;
  const [nowCo] = await admin`
    INSERT INTO master_companies (name, name_normalized, primary_domain, org_kind, field_provenance)
    VALUES ('Nowhere', 'nowhere', 'nowhere.com', 'company', '{"name":{}}'::jsonb) RETURNING id`;
  const stripeId = (stripe as { id: string }).id;
  const nowId = (nowCo as { id: string }).id;

  // EX-STRIPE: works at Nowhere now, worked at Stripe in the past (a RESOLVED stint — the import shape).
  const [ex] = await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility, current_company_id)
    VALUES ('ex-stripe', 'Ex Stripe', 'licensed', ${nowId}) RETURNING id`;
  const exId = (ex as { id: string }).id;
  await admin`
    INSERT INTO master_employment (master_person_id, master_company_id, is_current, is_primary, started_on, ended_on)
    VALUES (${exId}, ${nowId}, true, true, '2023-01-01', NULL),
           (${exId}, ${stripeId}, false, false, '2018-01-01', '2022-12-01')`;
  await admin`
    INSERT INTO master_person_skills (master_person_id, skill, source_count)
    VALUES (${exId}, 'Kubernetes', 4), (${exId}, 'Go', 2)`;
  await admin`
    INSERT INTO master_person_languages (master_person_id, name, proficiency)
    VALUES (${exId}, 'French', 'PROFESSIONAL_WORKING')`;
  await admin`
    INSERT INTO master_education (master_person_id, school_name_raw, school_name_normalized, degree, fields_of_study, started_on)
    VALUES (${exId}, 'State University', 'state university', 'BSc', ARRAY['Computer Science'], '2014-09-01')`;

  // UNRESOLVED: the employer was never matched to a company row — a normalized NAME and no company id.
  const [unres] = await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES ('unresolved-emp', 'Unresolved Emp', 'licensed') RETURNING id`;
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, company_name_raw, company_name_normalized,
       is_current, is_primary, started_on)
    VALUES (${(unres as { id: string }).id}, NULL, 'Stripe', 'stripe', false, false, '2019-01-01')`;

  // PLAIN: no satellites at all — the row an exclude filter must NOT drop.
  await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES ('plain-person', 'Plain Person', 'licensed')`;

  // PRIVATE: a full set of satellites, none of which may make them reachable.
  const [priv] = await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES ('pat-private', 'Pat Private', 'private') RETURNING id`;
  const privId = (priv as { id: string }).id;
  await admin`
    INSERT INTO master_employment (master_person_id, master_company_id, is_current, is_primary, started_on)
    VALUES (${privId}, ${stripeId}, false, false, '2015-01-01')`;
  await admin`
    INSERT INTO master_person_skills (master_person_id, skill) VALUES (${privId}, 'Kubernetes')`;
  await admin`
    INSERT INTO master_person_languages (master_person_id, name) VALUES (${privId}, 'French')`;
  await admin`
    INSERT INTO master_education (master_person_id, school_name_raw, school_name_normalized, fields_of_study)
    VALUES (${privId}, 'State University', 'state university', ARRAY['Computer Science'])`;
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("satellite filters", () => {
  test("1. skill matches, and is CASE-INSENSITIVE via citext", async () => {
    expect(await slugsFor("skill", ["Kubernetes"])).toEqual(["ex-stripe"]);
    // citext equality — the index-served form. A lower() wrapper here would defeat the 0135 btree.
    expect(await slugsFor("skill", ["kubernetes"])).toEqual(["ex-stripe"]);
  });

  test("2. language matches", async () => {
    expect(await slugsFor("language", ["French"])).toEqual(["ex-stripe"]);
  });

  test("3. school matches on the normalized name", async () => {
    expect(await slugsFor("school", ["state university"])).toEqual(["ex-stripe"]);
  });

  test("4. field of study matches through the array", async () => {
    expect(await slugsFor("field_of_study", ["Computer Science"])).toEqual(["ex-stripe"]);
    expect(await slugsFor("field_of_study", ["Basket Weaving"])).toEqual([]);
  });
});

describe("past employer", () => {
  test("5. a PAST employer matches — this is not a current-employer filter", async () => {
    // ex-stripe works at Nowhere now. A filter reading current_company_id would return nothing here.
    const slugs = await slugsFor("past_company", ["stripe"]);
    expect(slugs).toContain("ex-stripe");
  });

  test("6. both storage shapes match: a resolved company id AND an unresolved name", async () => {
    // The live import path writes a bare edge with a company id and NO name; an unmatched employer writes
    // the reverse. A single-leg implementation silently covers only half the graph.
    expect(await slugsFor("past_company", ["stripe"])).toEqual(["ex-stripe", "unresolved-emp"]);
  });

  test("7. the CURRENT employer also counts as an employer", async () => {
    expect(await slugsFor("past_company", ["nowhere"])).toEqual(["ex-stripe"]);
  });
});

describe("semantics that are easy to get wrong", () => {
  test("8. exclude keeps people who have NO value recorded at all", async () => {
    // "not skilled in Go" must include someone whose skills were never recorded. A bare NOT(...) over a
    // NULL-producing leg drops them, which reads as the exclude being far more aggressive than asked.
    const slugs = await slugsFor("skill", ["Go"], "exclude");
    expect(slugs).toContain("plain-person");
    expect(slugs).toContain("unresolved-emp");
    expect(slugs).not.toContain("ex-stripe");
  });

  test("9. a PRIVATE person is unreachable through EVERY satellite filter", async () => {
    // The join reintroduces rows; MASTER_PERSON_VISIBLE is what keeps them out. Asserted per filter so a
    // failure names the one that leaked.
    expect(await slugsFor("skill", ["Kubernetes"])).not.toContain("pat-private");
    expect(await slugsFor("language", ["French"])).not.toContain("pat-private");
    expect(await slugsFor("school", ["state university"])).not.toContain("pat-private");
    expect(await slugsFor("field_of_study", ["Computer Science"])).not.toContain("pat-private");
    expect(await slugsFor("past_company", ["stripe"])).not.toContain("pat-private");
  });

  test("10. the count path agrees with the page path", async () => {
    // buildWhere is shared by both; this pins that it stays shared rather than drifting into two clauses.
    const count = await db.withErTx((tx) =>
      db.masterPersonSearchRepository.countPersonsTx(tx, {
        filters: [{ kind: "term", field: "past_company", op: "include", values: ["stripe"] }],
        limit: 50,
      } as never),
    );
    expect(count.total).toBe(2);
    expect(count.capped).toBe(false);
  });

  test("11. suggest returns visible values only, prefix-matched", async () => {
    const rows = await db.withErTx((tx) =>
      db.masterPersonSearchRepository.suggestDatabaseValuesTx(tx, "skill", "kub", 10),
    );
    // One holder is visible, one is private — the count must reflect only the visible one, or it leaks
    // that the private person exists.
    expect(rows).toEqual([{ value: "Kubernetes", count: 1 }]);
  });

  test("12. suggest refuses a 1-character prefix", async () => {
    const rows = await db.withErTx((tx) =>
      db.masterPersonSearchRepository.suggestDatabaseValuesTx(tx, "skill", "k", 10),
    );
    expect(rows).toEqual([]);
  });
});
