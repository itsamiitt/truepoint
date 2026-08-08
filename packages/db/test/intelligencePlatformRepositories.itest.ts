// intelligencePlatformRepositories.itest.ts — the BEHAVIOUR of the Phase-6.2 repositories, as opposed to the
// access-path wall (intelligencePlatformIsolation.itest.ts).
//
// Each test here pins a decision that was argued in a comment and would otherwise be one refactor away from
// silently reverting:
//   • the adoption edge is EPISODE-grained — detected → removed → re-detected is three rows, and that
//     sequence IS the displacement signal;
//   • GREATEST/LEAST means a late-arriving OLD sighting can never make a stale detection look fresh;
//   • closeDetection returns a COUNT, and closing twice is not an error;
//   • recordPersonIdentifier RETURNS a conflict rather than swallowing it — an identifier held by another
//     person is the strongest merge hint ER can receive;
//   • an HQ upsert REPLACES rather than inserting a second row;
//   • a suppressed contact point writes nothing at all.
//
// ── ON THE CONCURRENCY TEST, AND WHY IT IS NOT WHAT IT LOOKS LIKE ────────────────────────────────────────
// recordDetection serialises on a transaction-scoped advisory lock rather than a unique constraint, because
// the episode grain forbids the unique. The obvious test — two concurrent withErTx calls — was NOT written,
// deliberately: withErTx runs on the owner pool, whose size is env-driven (DB_OWNER_POOL_MAX). If that is 1
// in the test environment, the two calls serialise on the POOL and the test passes without the lock existing
// at all. A green that proves nothing is worse than no test, because it retires the question.
//
// So the lock PRIMITIVE is tested directly on two independent connections, with a short lock_timeout so a
// held lock surfaces as 55P03 instead of hanging the suite. That proves the mechanism recordDetection relies
// on actually blocks; the repository's use of it is then a one-line read.
//
//   bun test ./packages/db/test/intelligencePlatformRepositories.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let companyId = "";
let otherCompanyId = "";
let techId = "";
let personA = "";
let personB = "";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-03-01T00:00:00Z");
const T2 = new Date("2026-06-01T00:00:00Z");

beforeAll(async () => {
  dbHandle = await startItestDb("intelPlatformRepos");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 3, onnotice: () => {} });
  dbmod = await import("../src/index.ts");

  const co = await admin<Array<{ id: string }>>`
    INSERT INTO master_companies (name, primary_domain) VALUES ('Acme','acme-repos.example')
    RETURNING id`;
  companyId = one(co).id;
  const co2 = await admin<Array<{ id: string }>>`
    INSERT INTO master_companies (name, primary_domain) VALUES ('Contoso','contoso-repos.example')
    RETURNING id`;
  otherCompanyId = one(co2).id;

  const pa = await admin<Array<{ id: string }>>`
    INSERT INTO master_persons (full_name, last_name) VALUES ('Jane Doe','Doe') RETURNING id`;
  personA = one(pa).id;
  const pb = await admin<Array<{ id: string }>>`
    INSERT INTO master_persons (full_name, last_name) VALUES ('J. Doe','Doe') RETURNING id`;
  personB = one(pb).id;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("masterTechnologyRepository — catalog resolution", () => {
  test("resolveTechnology mints once, then LINKs", async () => {
    const first = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.resolveTechnology(tx, {
        slug: "postgres",
        canonicalName: "PostgreSQL",
      }),
    );
    expect(first).toBeTruthy();
    techId = first as string;

    const second = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.resolveTechnology(tx, { slug: "postgres" }),
    );
    expect(second).toBe(techId);

    const n = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_technologies WHERE slug = 'postgres'`;
    expect(one(n).n).toBe(1);
  });

  // An alias shared by two technologies is a review task, not a coin flip — returning either one would
  // silently attach a detection to the wrong product.
  test("an AMBIGUOUS alias resolves to null rather than guessing", async () => {
    const other = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.resolveTechnology(tx, { slug: "atlas-db" }),
    );
    await admin`INSERT INTO master_technology_aliases (technology_id, alias) VALUES (${techId}, 'atlas')`;
    await admin`INSERT INTO master_technology_aliases (technology_id, alias) VALUES (${other}, 'atlas')`;

    const resolved = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.resolveTechnology(tx, { slug: "atlas" }),
    );
    expect(resolved).toBeNull();
  });
});

describe("masterTechnologyRepository — the episode grain", () => {
  test("first sighting OPENS an episode; a second EXTENDS it", async () => {
    const opened = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.recordDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        observedAt: T1,
      }),
    );
    expect(opened?.opened).toBe(true);

    const extended = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.recordDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        observedAt: T2,
      }),
    );
    expect(extended?.opened).toBe(false);
    expect(extended?.id).toBe(opened?.id as string);

    const row = await admin<Array<{ last_seen_at: Date; source_count: number }>>`
      SELECT last_seen_at, source_count FROM master_technology_adoptions WHERE id = ${opened?.id as string}`;
    expect(one(row).source_count).toBe(2);
    expect(one(row).last_seen_at.toISOString()).toBe(T2.toISOString());
  });

  // The reason valid time and transaction time are separate columns: a backfill delivering an OLD sighting
  // must not make a stale detection look fresh.
  test("a late-arriving OLDER sighting does not move last_seen_at backwards", async () => {
    await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.recordDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        observedAt: T0,
      }),
    );
    const row = await admin<Array<{ first_seen_at: Date; last_seen_at: Date }>>`
      SELECT first_seen_at, last_seen_at FROM master_technology_adoptions
       WHERE master_company_id = ${companyId} AND detection_method = 'dns' AND removed_at IS NULL`;
    expect(one(row).last_seen_at.toISOString()).toBe(T2.toISOString()); // unchanged
    expect(one(row).first_seen_at.toISOString()).toBe(T0.toISOString()); // widened backwards, correctly
  });

  test("closeDetection returns a COUNT, and closing an already-closed episode is 0, not an error", async () => {
    const closed = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.closeDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        removedAt: T2,
      }),
    );
    expect(closed).toBe(1);

    const again = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.closeDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        removedAt: T2,
      }),
    );
    expect(again).toBe(0);
  });

  // THE PROPERTY THE WHOLE GRAIN EXISTS FOR. If this ever returns opened:false, the displacement timeline is
  // gone and "re-adopted" becomes unrepresentable.
  test("re-detection AFTER a close opens a NEW episode, not a resurrection of the old one", async () => {
    const reopened = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.recordDetection(tx, {
        masterCompanyId: companyId,
        technologyId: techId,
        detectionMethod: "dns",
        observedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    expect(reopened?.opened).toBe(true);

    const rows = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_technology_adoptions
       WHERE master_company_id = ${companyId} AND technology_id = ${techId} AND detection_method = 'dns'`;
    expect(one(rows).n).toBe(2); // one closed episode + one open — three facts, two rows
  });

  test("listCompanyTechnologies returns only OPEN episodes", async () => {
    const live = await dbmod.withErTx((tx) =>
      dbmod.masterTechnologyRepository.listCompanyTechnologies(tx, companyId),
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.slug).toBe("postgres");
  });
});

describe("the advisory-lock PRIMITIVE recordDetection depends on", () => {
  // Two INDEPENDENT connections — not withErTx, whose owner pool is env-sized and could serialise the two
  // calls itself, producing a green that proves nothing.
  test("a second session cannot take the same xact lock while the first holds it", async () => {
    const a = postgres(dbHandle.adminUrl, { max: 1, onnotice: () => {} });
    const b = postgres(dbHandle.adminUrl, { max: 1, onnotice: () => {} });
    const key = 987654321;
    let blockedCode = "";

    try {
      await a.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${key})`;
        try {
          // lock_timeout turns "would block forever" into a fast, assertable failure. Without it a
          // regression here hangs the suite instead of failing it.
          await b`SET lock_timeout = '600ms'`;
          await b`SELECT pg_advisory_xact_lock(${key})`;
        } catch (e) {
          blockedCode = (e as { code?: string }).code ?? "";
        }
      });
    } finally {
      await a.end();
      await b.end();
    }

    expect(blockedCode).toBe("55P03"); // lock_not_available
  });
});

describe("masterCompanyDetailRepository", () => {
  test("recordPersonIdentifier: created, then existing for the SAME person", async () => {
    const created = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordPersonIdentifier(tx, {
        masterPersonId: personA,
        idType: "linkedin_public_id",
        idValue: "jane-doe-1",
      }),
    );
    expect(created.status).toBe("created");

    const existing = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordPersonIdentifier(tx, {
        masterPersonId: personA,
        idType: "linkedin_public_id",
        idValue: "jane-doe-1",
      }),
    );
    expect(existing.status).toBe("existing");
  });

  // THE ONE THAT MATTERS. `ON CONFLICT DO NOTHING` is the obvious implementation and it discards exactly the
  // signal ER exists to act on: two golden records claiming one identifier are the same person.
  test("recordPersonIdentifier RETURNS a conflict when another person holds the identifier", async () => {
    const conflict = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordPersonIdentifier(tx, {
        masterPersonId: personB,
        idType: "linkedin_public_id",
        idValue: "jane-doe-1",
      }),
    );
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.heldByPersonId).toBe(personA);
    }

    // And it did not quietly create a second row for the same key.
    const n = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_person_identifiers WHERE id_value = 'jane-doe-1'`;
    expect(one(n).n).toBe(1);
  });

  test("upsertCompanyLocation REPLACES the HQ instead of inserting a second", async () => {
    const first = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.upsertCompanyLocation(tx, {
        masterCompanyId: companyId,
        kind: "hq",
        city: "London",
        countryCode: "GB",
      }),
    );
    expect(first?.replaced).toBe(false);

    const second = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.upsertCompanyLocation(tx, {
        masterCompanyId: companyId,
        kind: "hq",
        city: "Manchester",
        countryCode: "GB",
      }),
    );
    expect(second?.replaced).toBe(true);
    expect(second?.id).toBe(first?.id as string);

    const rows = await admin<Array<{ n: number; city: string }>>`
      SELECT count(*)::int AS n, max(city) AS city FROM master_company_locations
       WHERE master_company_id = ${companyId} AND kind = 'hq'`;
    expect(one(rows).n).toBe(1);
    expect(one(rows).city).toBe("Manchester");
  });

  test("a non-HQ location is additive", async () => {
    await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.upsertCompanyLocation(tx, {
        masterCompanyId: companyId,
        kind: "office",
        city: "Leeds",
      }),
    );
    const rows = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_company_locations WHERE master_company_id = ${companyId}`;
    expect(one(rows).n).toBe(2);
  });

  // The failure mode this guards: a suppressed individual's address re-entering the graph through the
  // company door. Suppression returns null rather than throwing — a suppressed value in a provider feed is
  // a normal event, and a throw would abort an otherwise-fine batch.
  test("a SUPPRESSED contact point writes nothing and returns null", async () => {
    const refused = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordCompanyContactPoint(
        tx,
        {
          masterCompanyId: otherCompanyId,
          kind: "generic_email",
          valueNormalized: "info@contoso-repos.example",
        },
        { suppressed: true, reason: "global:email" },
      ),
    );
    expect(refused).toBeNull();

    const n = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_company_contact_points
       WHERE master_company_id = ${otherCompanyId}`;
    expect(one(n).n).toBe(0);
  });

  test("an UNsuppressed contact point is written and converges on re-record", async () => {
    const wrote = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordCompanyContactPoint(
        tx,
        {
          masterCompanyId: otherCompanyId,
          kind: "switchboard",
          valueNormalized: "+441234567890",
        },
        { suppressed: false },
      ),
    );
    expect(wrote?.suppressed).toBe(false);

    const again = await dbmod.withErTx((tx) =>
      dbmod.masterCompanyDetailRepository.recordCompanyContactPoint(
        tx,
        {
          masterCompanyId: otherCompanyId,
          kind: "switchboard",
          valueNormalized: "+441234567890",
        },
        { suppressed: false },
      ),
    );
    expect(again?.id).toBe(wrote?.id as string); // converged, not duplicated
  });
});

describe("masterSignalsRepository", () => {
  test("recordSignal writes a company signal and dedupes on evidence_ref", async () => {
    const sr = await admin<Array<{ id: string }>>`
      INSERT INTO source_records (source_name, content_hash, raw_data)
      VALUES ('itest', decode('aabb','hex'), '{}'::jsonb) RETURNING id`;
    const evidence = one(sr).id;

    const first = await dbmod.withErTx((tx) =>
      dbmod.masterSignalsRepository.recordSignal(tx, {
        subjectType: "company",
        subjectId: companyId,
        typeCode: "funding_round",
        observedAt: T1,
        headline: "Acme raised a Series B",
        payload: { round: "series_b" },
        evidenceRef: evidence,
      }),
    );
    expect(first?.duplicate).toBe(false);

    const replay = await dbmod.withErTx((tx) =>
      dbmod.masterSignalsRepository.recordSignal(tx, {
        subjectType: "company",
        subjectId: companyId,
        typeCode: "funding_round",
        observedAt: T1,
        evidenceRef: evidence,
      }),
    );
    expect(replay?.duplicate).toBe(true);
    expect(replay?.id).toBe(first?.id as string);
  });

  // The compliance control, proven end to end rather than only as a unit test of the guard.
  test("a payload carrying a contact value is REFUSED at the repository boundary", async () => {
    let threw = "";
    try {
      await dbmod.withErTx((tx) =>
        dbmod.masterSignalsRepository.recordSignal(tx, {
          subjectType: "person",
          subjectId: personA,
          typeCode: "job_change",
          observedAt: T1,
          payload: { new_employer_email: "jane@newco.example" },
        }),
      );
    } catch (e) {
      threw = (e as Error).message;
    }
    expect(threw).toContain("must not contain contact values");

    const n = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM master_signals WHERE subject_id = ${personA}`;
    expect(one(n).n).toBe(0);
  });
});
