// masterJobPostings.itest.ts — behavioural proof of the MI-S1 hiring-intelligence evidence table
// (migration 0127): partitioned DDL applies, the upsert is idempotent on (company, source, url) and
// refreshes state in place, the reads answer "who is hiring for what", and the app role holds NO grant
// (the ^master_ access-path wall — partition named directly included). On a real Postgres
// (Testcontainers or ITEST_DATABASE_URL). Run in its OWN process:
//   bun test ./packages/db/test/masterJobPostings.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

beforeAll(async () => {
  dbHandle = await startItestDb("master_job_postings");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("MI-S1 — master_job_postings", () => {
  let companyId = "";

  test("1. upsert is idempotent per (company, source, url) and refreshes state in place", async () => {
    const [c] = await admin`
      INSERT INTO master_companies (name, name_normalized)
      VALUES ('Hiring Corp', 'hiring corp') RETURNING id`;
    companyId = (c as { id: string }).id;

    const base = {
      masterCompanyId: companyId,
      sourceName: "postings_feed",
      canonicalUrl: "https://jobs.example/hiring-corp/vp-eng",
      title: "VP Engineering",
      department: "Engineering",
      seniorityLevel: "vp",
      location: "Remote",
      postedAt: "2026-08-01",
      observedAt: new Date(),
    };
    const first = await db.withErTx((tx) => db.masterJobPostingsRepository.upsertPosting(tx, base));
    expect(first.created).toBe(true);

    // Re-sync: same identity, moved state — one row, refreshed, not duplicated.
    const second = await db.withErTx((tx) =>
      db.masterJobPostingsRepository.upsertPosting(tx, {
        ...base,
        title: "VP of Engineering",
        observedAt: new Date(),
      }),
    );
    expect(second.created).toBe(false);
    const rows =
      await admin`SELECT title FROM master_job_postings WHERE master_company_id = ${companyId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("VP of Engineering");
  });

  test("2. reads: open list + by-department counts; a closed posting drops out", async () => {
    await db.withErTx(async (tx) => {
      await db.masterJobPostingsRepository.upsertPosting(tx, {
        masterCompanyId: companyId,
        sourceName: "postings_feed",
        canonicalUrl: "https://jobs.example/hiring-corp/ae",
        title: "Account Executive",
        department: "Sales",
        seniorityLevel: "ic",
        postedAt: "2026-08-10",
        observedAt: new Date(),
      });
      await db.masterJobPostingsRepository.upsertPosting(tx, {
        masterCompanyId: companyId,
        sourceName: "postings_feed",
        canonicalUrl: "https://jobs.example/hiring-corp/closed-role",
        title: "Old Role",
        department: "Sales",
        postedAt: "2026-06-01",
        closedAt: "2026-07-01",
        observedAt: new Date(),
      });
    });

    const open = await db.withErTx((tx) =>
      db.masterJobPostingsRepository.listOpenForCompany(tx, companyId),
    );
    expect(open.map((p) => p.title).sort()).toEqual(["Account Executive", "VP of Engineering"]);

    const byDept = await db.withErTx((tx) =>
      db.masterJobPostingsRepository.countOpenByDepartment(tx, companyId),
    );
    expect(new Map(byDept.map((d) => [d.department, d.count]))).toEqual(
      new Map([
        ["Engineering", 1],
        ["Sales", 1],
      ]),
    );
  });

  test("3. the app role holds no grant — parent AND a named partition both refuse", async () => {
    const appUrl = new URL(dbHandle.adminUrl);
    appUrl.username = "leadwolf_app";
    appUrl.password = "Lw_App_Role_2026!x7Qm";
    const app = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });
    const denied = await app`SELECT count(*) FROM master_job_postings`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(denied)).toContain("permission denied");
    const deniedPartition = await app`SELECT count(*) FROM master_job_postings_p00`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(deniedPartition)).toContain("permission denied");
    await app.end();
  });
});
