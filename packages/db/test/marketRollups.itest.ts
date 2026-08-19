// marketRollups.itest.ts — behavioural proof of the MI-S7 segment rollup (migration 0130): the rebuild
// aggregates funding/signals/headcount-delta by (industry × country × band × month), is idempotent
// (second rebuild converges byte-identically), and the app role holds no grant. On a real Postgres
// (Testcontainers or ITEST_DATABASE_URL). Run in its OWN process:
//   bun test ./packages/db/test/marketRollups.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

beforeAll(async () => {
  dbHandle = await startItestDb("market_rollups");
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

describe("MI-S7 — master_market_rollups", () => {
  test("1. rebuild aggregates by segment and month; the read seam returns the window", async () => {
    // Two software companies (one with country+band), one healthcare company.
    const [sw] = await admin`SELECT id FROM master_industries WHERE code = 'software'`;
    const [hc] = await admin`SELECT id FROM master_industries WHERE code = 'providers-hospitals'`;
    const softwareId = (sw as { id: string }).id;
    const healthId = (hc as { id: string }).id;

    const mk = async (
      name: string,
      industryId: string,
      country: string | null,
      band: string | null,
    ) => {
      const [r] = await admin`
        INSERT INTO master_companies (name, name_normalized, industry_id, hq_country, employee_band)
        VALUES (${name}, ${name.toLowerCase()}, ${industryId}, ${country}, ${band}) RETURNING id`;
      return (r as { id: string }).id;
    };
    const a = await mk("Rollup Soft A", softwareId, "United States", "51-200");
    const b = await mk("Rollup Soft B", softwareId, "United States", "51-200");
    const c = await mk("Rollup Health", healthId, null, null);

    // Funding this month for A; a company signal for B; a headcount step for C.
    await admin`
      INSERT INTO master_company_funding (master_company_id, round_type, amount_minor, currency, announced_on)
      VALUES (${a}, 'series_a', 500000000, 'USD', date_trunc('month', now())::date + 2)`;
    await admin`
      INSERT INTO master_signals (subject_type, subject_id, type_code, payload, observed_at)
      VALUES ('company', ${b}, 'exec_hired', '{}'::jsonb, now())`;
    const thisMonth = "date_trunc('month', now())::date";
    await admin.unsafe(`
      INSERT INTO master_company_headcount (master_company_id, month, job_function, employee_count, source_name, observed_at)
      VALUES ('${c}', (${thisMonth} - interval '1 month')::date, '', 100, 'itest', now()),
             ('${c}', ${thisMonth}, '', 130, 'itest', now())`);

    const first = await db.marketRollupRepository.rebuild(3);
    expect(first.rows).toBeGreaterThan(0);

    const segments = await db.withErTx((tx) =>
      db.marketRollupRepository.readSegments(tx, { months: 3 }),
    );
    const swRow = segments.find(
      (s) =>
        s.industryCode === "software" && s.month.startsWith(new Date().toISOString().slice(0, 7)),
    );
    expect(swRow?.companyCount).toBe(2);
    expect(swRow?.fundingRounds).toBe(1);
    expect(swRow?.fundingAmountMinor).toBe(500000000);
    expect(swRow?.signalCount).toBe(1);
    const hcRow = segments.find(
      (s) =>
        s.industryCode === "providers-hospitals" &&
        s.month.startsWith(new Date().toISOString().slice(0, 7)),
    );
    expect(hcRow?.headcountDelta).toBe(30);
  });

  test("2. rebuild is idempotent — a second run converges to the same rows", async () => {
    const before = await admin`
      SELECT industry_code, month::text AS month, company_count, funding_rounds, signal_count, headcount_delta
        FROM master_market_rollups ORDER BY 1, 2, 3`;
    await db.marketRollupRepository.rebuild(3);
    const after = await admin`
      SELECT industry_code, month::text AS month, company_count, funding_rounds, signal_count, headcount_delta
        FROM master_market_rollups ORDER BY 1, 2, 3`;
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  });

  test("3. the app role holds no grant on the rollup cache", async () => {
    const appUrl = new URL(dbHandle.adminUrl);
    appUrl.username = "leadwolf_app";
    appUrl.password = "Lw_App_Role_2026!x7Qm";
    const app = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });
    const denied = await app`SELECT count(*) FROM master_market_rollups`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(denied)).toContain("permission denied");
    await app.end();
  });
});
