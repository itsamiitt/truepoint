// masterHeadcount.itest.ts — behavioural proof of the 0113/0114 linkedin_api storage substrate:
// master_company_headcount (HASH-partitioned monthly series) + master_company_identifiers (the company
// external-id twin). Run in its OWN process:
//   bun test ./packages/db/test/masterHeadcount.itest.ts
//
// Proofs:
//   1. UPSERT CONVERGENCE — two overlapping refetches (25-month windows shifted a month) converge to one
//      row per (company, month, function); counts take the newer observation.
//   2. STALE REPLAY NO-OPS — an upsert with an OLDER observed_at leaves the stored count untouched.
//   3. GROWTH IS DERIVED — a lag() window query over the series reproduces the vendor's one_month growth
//      numbers from the Anthem-shaped fixture (no stored rollups anywhere).
//   4. THE ACL WALL — leadwolf_app is denied on the PARENT and on a PARTITION BY NAME (42501); leadwolf_er
//      writes fine through the parent. Same for master_company_identifiers.
//   5. IDENTIFIER CONVERGENCE + 0113 BACKFILL — concurrent identifier claims converge on the global
//      (id_type,id_value) unique; the backfill made column and table agree.
//
// DB error capture uses try/catch, NEVER expect(...).rejects (the pooled-connection hang trap).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;
let companyId = "";

function months(
  startYear: number,
  startMonth: number,
  counts: number[],
): Array<{
  monthIso: string;
  jobFunction: string;
  count: number;
}> {
  return counts.map((count, i) => {
    const m = startMonth + i;
    const year = startYear + Math.floor((m - 1) / 12);
    const month = ((m - 1) % 12) + 1;
    return {
      monthIso: `${year}-${String(month).padStart(2, "0")}-01`,
      jobFunction: "",
      count,
    };
  });
}

beforeAll(async () => {
  dbHandle = await startItestDb("masterHeadcount");
  process.env.DATABASE_URL = dbHandle.adminUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");

  const [c] = await admin`
    INSERT INTO master_companies (name, linkedin_company_id) VALUES ('Anthem Itest', '2619000')
    RETURNING id`;
  companyId = (c as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("master_company_headcount — the monthly series (0114)", () => {
  test("1. overlapping refetches converge to one row per month; newer observation wins", async () => {
    const t1 = new Date("2026-07-15T00:00:00.000Z");
    const t2 = new Date("2026-08-15T00:00:00.000Z");
    // First fetch: Jan–Jul window.
    await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.upsertHeadcountSeries(
        tx,
        companyId,
        months(2026, 1, [18440, 18414, 18380, 18348, 18262, 18269, 18282]),
        "linkedin_api",
        t1,
      ),
    );
    // Second fetch a month later: Feb–Aug window, one revised count (Jul 18283 vs 18282).
    await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.upsertHeadcountSeries(
        tx,
        companyId,
        months(2026, 2, [18414, 18380, 18348, 18262, 18269, 18283, 18287]),
        "linkedin_api",
        t2,
      ),
    );

    const rows = await admin`
      SELECT month::text AS month, employee_count FROM master_company_headcount
       WHERE master_company_id = ${companyId} AND job_function = '' ORDER BY month`;
    expect(rows).toHaveLength(8); // Jan..Aug — union, not duplication
    expect(rows.find((r) => r.month === "2026-07-01")!.employee_count).toBe(18283); // newer won
    expect(rows.find((r) => r.month === "2026-08-01")!.employee_count).toBe(18287);
  });

  test("2. a STALE replay (older observed_at) no-ops", async () => {
    const stale = new Date("2026-01-01T00:00:00.000Z");
    await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.upsertHeadcountSeries(
        tx,
        companyId,
        [{ monthIso: "2026-07-01", jobFunction: "", count: 1 }],
        "linkedin_api",
        stale,
      ),
    );
    const [row] = await admin`
      SELECT employee_count FROM master_company_headcount
       WHERE master_company_id = ${companyId} AND month = '2026-07-01' AND job_function = ''`;
    expect(row!.employee_count).toBe(18283); // untouched
  });

  test("3. growth windows are DERIVED: lag() reproduces the vendor's one-month numbers", async () => {
    const [latest] = await admin`
      WITH series AS (
        SELECT month, employee_count,
               lag(employee_count) OVER (ORDER BY month) AS prev
          FROM master_company_headcount
         WHERE master_company_id = ${companyId} AND job_function = ''
      )
      SELECT employee_count, prev, employee_count - prev AS change
        FROM series ORDER BY month DESC LIMIT 1`;
    expect(latest!.employee_count).toBe(18287);
    expect(latest!.prev).toBe(18283);
    expect(latest!.change).toBe(4);
  });

  test("4a. er reads the series via the repository (parent-routed, index-backed)", async () => {
    const totals = await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.listHeadcountTotals(tx, companyId, 3),
    );
    expect(totals[0]).toEqual({ month: "2026-08-01", employeeCount: 18287 });
  });

  // Kept as its OWN test so an environment-specific app-role login failure (the known local 28P01 the
  // sibling masterGraphResolve itest shows too) cannot mask the substance proofs above.
  test("4b. the wall: leadwolf_app denied on the parent AND on a partition BY NAME (42501)", async () => {
    let parentCode: string | null = null;
    try {
      await app`SELECT count(*) FROM master_company_headcount`;
    } catch (e) {
      parentCode = (e as { code?: string }).code ?? null;
    }
    expect(parentCode).toBe(PERMISSION_DENIED);

    let partitionCode: string | null = null;
    try {
      await app`SELECT count(*) FROM master_company_headcount_p07`;
    } catch (e) {
      partitionCode = (e as { code?: string }).code ?? null;
    }
    expect(partitionCode).toBe(PERMISSION_DENIED);
  });
});

describe("master_company_identifiers — the company external-id twin (0113)", () => {
  test("5a. er writes; the global unique converges concurrent claims", async () => {
    // Two concurrent-ish claims of the same (type, value) against different companies: the second is a
    // DO-NOTHING and the value stays with its first owner (a merge signal, not two rows).
    const [other] = await admin`
      INSERT INTO master_companies (name) VALUES ('Rival Claimant') RETURNING id`;
    const otherId = (other as { id: string }).id;
    await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.upsertCompanyIdentifiers(
        tx,
        companyId,
        [{ idType: "linkedin_company_slug", idValue: "itest-shared-slug" }],
        "linkedin_api",
        new Date(),
      ),
    );
    await dbmod.withErTx((tx) =>
      dbmod.masterProfileRepository.upsertCompanyIdentifiers(
        tx,
        otherId,
        [{ idType: "linkedin_company_slug", idValue: "itest-shared-slug" }],
        "linkedin_api",
        new Date(),
      ),
    );
    const owners = await admin`
      SELECT master_company_id FROM master_company_identifiers
       WHERE id_type = 'linkedin_company_slug' AND id_value = 'itest-shared-slug'`;
    expect(owners).toHaveLength(1);
    expect(owners[0]!.master_company_id).toBe(companyId);
  });

  test("5b. the 0113 backfill: every linkedin_company_id column value has an agreeing identifier row", async () => {
    const [mismatch] = await admin`
      SELECT count(*)::int AS n
        FROM master_companies c
       WHERE c.linkedin_company_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM master_company_identifiers i
            WHERE i.id_type = 'linkedin_company_id'
              AND i.id_value = c.linkedin_company_id::citext
              AND i.master_company_id = c.id
         )
         -- rows created AFTER the migration by tests are outside the backfill's contract unless the
         -- landing wrote their identifier; the seeded company above was inserted directly, so exclude it.
         AND c.id <> ${companyId}`;
    expect(mismatch!.n).toBe(0);
  });

  test("5c. resolver LINKs a company by identifier slug (LINK-only key)", async () => {
    const resolved = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinCompanySlug: "itest-shared-slug",
        companyName: "ignored — LINK path",
      }),
    );
    expect(resolved.masterCompanyId).toBe(companyId);
    expect(resolved.masterPersonId).toBeNull(); // slug alone never resolves or mints a person
  });

  test("5d. the wall: leadwolf_app denied on master_company_identifiers (42501)", async () => {
    let code: string | null = null;
    try {
      await app`SELECT count(*) FROM master_company_identifiers`;
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    expect(code).toBe(PERMISSION_DENIED);
  });
});
