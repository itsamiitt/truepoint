// masterProfileRead.itest.ts — behavioural proof of the composed GLOBAL profile reads
// (search-consolidation stage 3). On a real Postgres (Testcontainers or ITEST_DATABASE_URL).
// Run in its OWN process — the db client is a module singleton:
//   bun test ./packages/db/test/masterProfileRead.itest.ts
//
// Two properties here are the ones that would ship broken and look fine:
//
//   1. THE '-infinity' SENTINEL. master_employment.started_on defaults to '-infinity', meaning "start
//      unknown" — it exists so the dedup unique (person, company, started_on) collides for unknown starts.
//      It is not a date. Rendered as one it reads as ~2000 years of tenure, and any duration derived from
//      it is nonsense. Test 2 pins that it comes back as NULL.
//
//   2. VISIBILITY ON EVERY COLLECTION, not just the identity read. It is easy to gate the person lookup and
//      forget the four joins that hang off it, at which point a private person's employment history is
//      readable by slug even though the person is not. Test 5 pins each collection separately.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

beforeAll(async () => {
  dbHandle = await startItestDb("master_profile_read");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");

  const [visibleCo] = await admin`
    INSERT INTO master_companies (name, name_normalized, primary_domain, org_kind, field_provenance)
    VALUES ('Acme', 'acme', 'acme.com', 'company', '{"name":{}}'::jsonb) RETURNING id`;
  const companyId = (visibleCo as { id: string }).id;

  const [visible] = await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility, current_company_id)
    VALUES ('jane-visible', 'Jane Visible', 'licensed', ${companyId}) RETURNING id`;
  const [priv] = await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES ('pat-private', 'Pat Private', 'private') RETURNING id`;
  const visibleId = (visible as { id: string }).id;
  const privateId = (priv as { id: string }).id;

  // Jane: one stint with a KNOWN start, one with the '-infinity' sentinel.
  await admin`
    INSERT INTO master_employment
      (master_person_id, master_company_id, company_name_raw, company_name_normalized,
       title, is_current, is_primary, started_on)
    VALUES
      (${visibleId}, ${companyId}, 'Acme', 'acme', 'VP Engineering', true, true, '2020-03-01'),
      (${visibleId}, NULL, 'Older Co', 'older co', 'Engineer', false, false, '-infinity')`;

  await admin`
    INSERT INTO master_education (master_person_id, school_name_raw, school_name_normalized, degree, started_on)
    VALUES (${visibleId}, 'State University', 'state university', 'BSc', '-infinity')`;
  await admin`
    INSERT INTO master_person_skills (master_person_id, skill, source_count)
    VALUES (${visibleId}, 'Kubernetes', 5), (${visibleId}, 'Go', 2)`;
  await admin`
    INSERT INTO master_person_languages (master_person_id, name, proficiency, source_count)
    VALUES (${visibleId}, 'English', 'native', 3)`;

  // The PRIVATE person gets a full history too — that is the point of test 5.
  await admin`
    INSERT INTO master_employment
      (master_person_id, company_name_raw, company_name_normalized, title, is_current, is_primary, started_on)
    VALUES (${privateId}, 'Secret Co', 'secret co', 'CTO', true, true, '2019-01-01')`;
  await admin`
    INSERT INTO master_person_skills (master_person_id, skill) VALUES (${privateId}, 'Rust')`;
  await admin`
    INSERT INTO master_person_languages (master_person_id, name) VALUES (${privateId}, 'French')`;
  await admin`
    INSERT INTO master_education (master_person_id, school_name_raw, school_name_normalized)
    VALUES (${privateId}, 'Hidden College', 'hidden college')`;
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("profile collections", () => {
  test("1. employment comes back primary-first with the joined company name", async () => {
    const rows = await db.withErTx((tx) =>
      db.masterProfileReadRepository.employmentForSlugTx(tx, "jane-visible", 25),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.isPrimary).toBe(true);
    expect(rows[0]?.title).toBe("VP Engineering");
    // Joined from master_companies when the edge is bridged, falling back to the raw string when not.
    expect(rows[0]?.companyName).toBe("Acme");
    expect(rows[1]?.companyName).toBe("Older Co");
  });

  test("2. the '-infinity' start SENTINEL reads as null, not as a date", async () => {
    const rows = await db.withErTx((tx) =>
      db.masterProfileReadRepository.employmentForSlugTx(tx, "jane-visible", 25),
    );
    const sentinelStint = rows.find((r) => r.title === "Engineer");
    expect(sentinelStint).toBeDefined();
    expect(sentinelStint?.startedOn).toBeNull();

    // A real date still survives — the NULLIF must not blanket-null the column.
    expect(rows.find((r) => r.title === "VP Engineering")?.startedOn).toBe("2020-03-01");

    // Same sentinel, same treatment, on the education edge.
    const edu = await db.withErTx((tx) =>
      db.masterProfileReadRepository.educationForSlugTx(tx, "jane-visible", 10),
    );
    expect(edu[0]?.startedOn).toBeNull();
  });

  test("3. skills are most-corroborated first and languages carry proficiency", async () => {
    const [skills, languages] = await db.withErTx((tx) =>
      Promise.all([
        db.masterProfileReadRepository.skillsForSlugTx(tx, "jane-visible", 50),
        db.masterProfileReadRepository.languagesForSlugTx(tx, "jane-visible", 10),
      ]),
    );
    expect(skills).toEqual(["Kubernetes", "Go"]);
    expect(languages).toEqual([{ name: "English", proficiency: "native" }]);
  });

  test("4. every collection honours its LIMIT", async () => {
    const rows = await db.withErTx((tx) =>
      db.masterProfileReadRepository.employmentForSlugTx(tx, "jane-visible", 1),
    );
    expect(rows).toHaveLength(1);
  });

  test("5. a PRIVATE person's collections are invisible — every one, not just the identity read", async () => {
    // The easy bug is gating readVisiblePerson and forgetting the joins that hang off the slug. Each of
    // these is asserted separately so a failure names the collection that leaked.
    const [employment, education, skills, languages, hasMobile] = await db.withErTx((tx) =>
      Promise.all([
        db.masterProfileReadRepository.employmentForSlugTx(tx, "pat-private", 25),
        db.masterProfileReadRepository.educationForSlugTx(tx, "pat-private", 10),
        db.masterProfileReadRepository.skillsForSlugTx(tx, "pat-private", 50),
        db.masterProfileReadRepository.languagesForSlugTx(tx, "pat-private", 10),
        db.masterProfileReadRepository.hasMobileForSlugTx(tx, "pat-private"),
      ]),
    );
    expect(employment).toEqual([]);
    expect(education).toEqual([]);
    expect(skills).toEqual([]);
    expect(languages).toEqual([]);
    expect(hasMobile).toBe(false);

    // …and the person themself is absent, so absent and not-visible are the same 404.
    const person = await db.withErTx((tx) =>
      db.masterPersonReadRepository.readVisiblePerson(tx, { slug: "pat-private" }),
    );
    expect(person).toBeNull();
  });

  test("6. hasMobile is a PRESENCE bit — true only for line_type='mobile'", async () => {
    const [p] = await admin`
      SELECT id FROM master_persons WHERE linkedin_public_id = 'jane-visible'`;
    const personId = (p as { id: string }).id;

    expect(
      await db.withErTx((tx) =>
        db.masterProfileReadRepository.hasMobileForSlugTx(tx, "jane-visible"),
      ),
    ).toBe(false);

    // A landline must NOT flip it — the whole point of the S-04 signal is which kind of number exists.
    await admin`
      INSERT INTO master_phones (master_person_id, phone_enc, phone_blind_index, line_type)
      VALUES (${personId}, '\\x00'::bytea, '\\x01'::bytea, 'hq')`;
    expect(
      await db.withErTx((tx) =>
        db.masterProfileReadRepository.hasMobileForSlugTx(tx, "jane-visible"),
      ),
    ).toBe(false);

    await admin`
      INSERT INTO master_phones (master_person_id, phone_enc, phone_blind_index, line_type)
      VALUES (${personId}, '\\x02'::bytea, '\\x03'::bytea, 'mobile')`;
    expect(
      await db.withErTx((tx) =>
        db.masterProfileReadRepository.hasMobileForSlugTx(tx, "jane-visible"),
      ),
    ).toBe(true);
  });
});
