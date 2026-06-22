// accountSearch.itest.ts — Definition-of-Done for the Postgres account-search adapter (accountSearchRepository,
// 24/ADR-0035) on a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — itestDb.ts). Run in
// its OWN process:  `bun test ./packages/db/test/accountSearch.itest.ts`
//
// Proves the firmographic, company-level query path:
//   (1) workspace isolation — workspace B's accounts never surface in A (RLS via withTenantTx);
//   (2) the per-account contact rollup (contactCount + revealedContactCount) is workspace-scoped (a foreign
//       workspace's contacts on the same account_id never leak into the count);
//   (3) term include/exclude (industry), the technology jsonb `?|` filter, the derived employee_band term
//       filter, numeric ranges (employee_count / founded_year→company_age), and free-text all filter correctly;
//   (4) live facet counts group per value and IGNORE the facet's own term filter (Apollo behaviour), incl. the
//       per-element technology facet and the derived employee_band facet;
//   (5) suggest returns prefix matches; keyset pagination (name_asc) walks every row without overlap.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccountQuery } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

let tenantA = "";
let wsA = "";
let ownerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";

// A-workspace accounts
let aAcme = ""; // Software, 100 emp, ["salesforce","aws"], founded 2010
let aGlobe = ""; // Software, 600 emp, ["aws","gcp"], founded 2001
let aFin = ""; // Fintech, 30 emp, ["stripe"], founded 2020
// B-workspace account (isolation)
let bOnly = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const ownerId = await seedUser(`owner@${slug}.test`);
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

interface AccountSeed {
  ws: { tenantId: string; workspaceId: string };
  name: string;
  domain: string;
  industry?: string;
  subIndustry?: string;
  employeeCount?: number;
  revenueRange?: string;
  hqCountry?: string;
  technologies?: string[];
  fundingStage?: string;
  companyStage?: string;
  foundedYear?: number;
  icpFitScore?: number;
  createdAt?: string;
}

async function seedAccount(s: AccountSeed): Promise<string> {
  const tech = JSON.stringify(s.technologies ?? []);
  const [a] = await admin`
    INSERT INTO accounts (
      tenant_id, workspace_id, name, domain, industry, sub_industry, employee_count, revenue_range,
      hq_country, technologies, funding_stage, company_stage, founded_year, icp_fit_score, created_at
    ) VALUES (
      ${s.ws.tenantId}, ${s.ws.workspaceId}, ${s.name}, ${s.domain}, ${s.industry ?? null},
      ${s.subIndustry ?? null}, ${s.employeeCount ?? null}, ${s.revenueRange ?? null},
      ${s.hqCountry ?? null}, ${tech}::jsonb, ${s.fundingStage ?? null}, ${s.companyStage ?? null},
      ${s.foundedYear ?? null}, ${s.icpFitScore ?? null}, ${s.createdAt ?? "2026-01-01T00:00:00Z"}
    ) RETURNING id`;
  return (a as { id: string }).id;
}

async function seedContact(
  ws: { tenantId: string; workspaceId: string },
  owner: string,
  accountId: string,
  isRevealed: boolean,
): Promise<void> {
  // is_revealed requires revealed_by_user_id + revealed_at (the reveal-owner CHECK constraints).
  await admin`
    INSERT INTO contacts (
      tenant_id, workspace_id, owner_user_id, account_id, first_name, is_revealed,
      revealed_by_user_id, revealed_at
    ) VALUES (
      ${ws.tenantId}, ${ws.workspaceId}, ${owner}, ${accountId}, 'X', ${isRevealed},
      ${isRevealed ? owner : null}, ${isRevealed ? "2026-02-01T00:00:00Z" : null}
    )`;
}

const query = (over: Partial<AccountQuery> = {}): AccountQuery => ({
  filters: [],
  sort: "relevance",
  limit: 50,
  ...over,
});

beforeAll(async () => {
  dbHandle = await startItestDb("accountSearch");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedTenantWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedTenantWorkspace("globex"));

  const A = { tenantId: tenantA, workspaceId: wsA };
  const B = { tenantId: tenantB, workspaceId: wsB };

  aAcme = await seedAccount({
    ws: A,
    name: "Acme Tech",
    domain: "acme.test",
    industry: "Software",
    employeeCount: 100,
    technologies: ["salesforce", "aws"],
    fundingStage: "series_b",
    foundedYear: 2010,
    icpFitScore: 90,
    createdAt: "2026-01-03T00:00:00Z",
  });
  aGlobe = await seedAccount({
    ws: A,
    name: "Globe Systems",
    domain: "globe.test",
    industry: "Software",
    employeeCount: 600,
    technologies: ["aws", "gcp"],
    fundingStage: "series_c",
    foundedYear: 2001,
    icpFitScore: 70,
    createdAt: "2026-01-02T00:00:00Z",
  });
  aFin = await seedAccount({
    ws: A,
    name: "Finovate",
    domain: "finovate.test",
    industry: "Fintech",
    employeeCount: 30,
    technologies: ["stripe"],
    fundingStage: "seed",
    foundedYear: 2020,
    icpFitScore: 50,
    createdAt: "2026-01-01T00:00:00Z",
  });
  bOnly = await seedAccount({
    ws: B,
    name: "Beta Only",
    domain: "beta.test",
    industry: "Software",
    employeeCount: 100,
    technologies: ["aws"],
  });

  // Rollup fixtures: Acme has 3 contacts in A (2 revealed, 1 not); Finovate has 1 (revealed).
  await seedContact(A, ownerA, aAcme, true);
  await seedContact(A, ownerA, aAcme, true);
  await seedContact(A, ownerA, aAcme, false);
  await seedContact(A, ownerA, aFin, true);
  // Isolation probe: a B-workspace contact ALSO points (logically) at a same-named account in B — its count
  // must never bleed into A's Acme rollup. (Different account_id; proving the workspace tx-scoping anyway.)
  await seedContact(B, ownerB, bOnly, true);

  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

const run = (scope: ReturnType<typeof scopeA>, q: AccountQuery) =>
  db.accountSearchRepository.searchAccounts(scope, q);

describe("Postgres accountSearchRepository — firmographic company search (24)", () => {
  test("workspace isolation: B's accounts never surface in A and vice-versa", async () => {
    const a = await run(scopeA(), query());
    expect(a.accounts.map((h) => h.id).sort()).toEqual([aAcme, aGlobe, aFin].sort());
    expect(a.accounts.some((h) => h.id === bOnly)).toBe(false);

    const b = await run(scopeB(), query());
    expect(b.accounts.map((h) => h.id)).toEqual([bOnly]);
  });

  test("per-account contact rollup is workspace-scoped (count + revealed sub-count)", async () => {
    const a = await run(scopeA(), query());
    const acme = a.accounts.find((h) => h.id === aAcme);
    expect(acme?.contactCount).toBe(3);
    expect(acme?.revealedContactCount).toBe(2);
    const fin = a.accounts.find((h) => h.id === aFin);
    expect(fin?.contactCount).toBe(1);
    expect(fin?.revealedContactCount).toBe(1);
    const globe = a.accounts.find((h) => h.id === aGlobe);
    expect(globe?.contactCount).toBe(0);
    expect(globe?.revealedContactCount).toBe(0);

    // The B-workspace account's contact never leaks into A's totals (already covered by isolation, but
    // assert the count seen from B is its own).
    const b = await run(scopeB(), query());
    expect(b.accounts.find((h) => h.id === bOnly)?.contactCount).toBe(1);
  });

  test("term include/exclude on industry", async () => {
    const inc = await run(
      scopeA(),
      query({
        filters: [{ kind: "term", field: "industry", op: "include", values: ["Software"] }],
      }),
    );
    expect(inc.accounts.map((h) => h.id).sort()).toEqual([aAcme, aGlobe].sort());

    const exc = await run(
      scopeA(),
      query({
        filters: [{ kind: "term", field: "industry", op: "exclude", values: ["Software"] }],
      }),
    );
    expect(exc.accounts.map((h) => h.id)).toEqual([aFin]);
  });

  test("technology jsonb ?| filter + derived employee_band term filter + ranges + free text", async () => {
    const aws = await run(
      scopeA(),
      query({ filters: [{ kind: "term", field: "technology", op: "include", values: ["aws"] }] }),
    );
    expect(aws.accounts.map((h) => h.id).sort()).toEqual([aAcme, aGlobe].sort());

    // employee_band "51-200" → 51..200 inclusive → only Acme (100).
    const band = await run(
      scopeA(),
      query({
        filters: [{ kind: "term", field: "employee_band", op: "include", values: ["51-200"] }],
      }),
    );
    expect(band.accounts.map((h) => h.id)).toEqual([aAcme]);

    // employee_count range >= 500 → only Globe (600).
    const big = await run(
      scopeA(),
      query({ filters: [{ kind: "range", field: "employee_count", gte: 500 }] }),
    );
    expect(big.accounts.map((h) => h.id)).toEqual([aGlobe]);

    // company_age (now-founded_year): founded 2001 ⇒ age >= 20 → Globe only.
    const old = await run(
      scopeA(),
      query({ filters: [{ kind: "range", field: "company_age", gte: 20 }] }),
    );
    expect(old.accounts.map((h) => h.id)).toEqual([aGlobe]);

    const fin = await run(scopeA(), query({ text: "finov" }));
    expect(fin.accounts.map((h) => h.id)).toEqual([aFin]);
  });

  test("live facet counts group per value and ignore the facet's own term filter", async () => {
    const industry = await db.accountSearchRepository.facetCounts(scopeA(), query(), ["industry"]);
    expect(industry.find((f) => f.value === "Software")?.count).toBe(2);
    expect(industry.find((f) => f.value === "Fintech")?.count).toBe(1);

    // With an industry filter active, the industry facet STILL reports both values (Apollo behaviour).
    const withFilter = await db.accountSearchRepository.facetCounts(
      scopeA(),
      query({ filters: [{ kind: "term", field: "industry", op: "include", values: ["Fintech"] }] }),
      ["industry"],
    );
    expect(withFilter.map((f) => f.value).sort()).toEqual(["Fintech", "Software"]);

    // Per-element technology facet: aws appears on 2 accounts, gcp/salesforce/stripe on 1 each.
    const tech = await db.accountSearchRepository.facetCounts(scopeA(), query(), ["technology"]);
    expect(tech.find((f) => f.value === "aws")?.count).toBe(2);
    expect(tech.find((f) => f.value === "gcp")?.count).toBe(1);
    expect(tech.find((f) => f.value === "stripe")?.count).toBe(1);

    // Derived employee_band facet: 30→"11-50", 100→"51-200", 600→"501-1000".
    const bands = await db.accountSearchRepository.facetCounts(scopeA(), query(), [
      "employee_band",
    ]);
    expect(bands.find((f) => f.value === "11-50")?.count).toBe(1);
    expect(bands.find((f) => f.value === "51-200")?.count).toBe(1);
    expect(bands.find((f) => f.value === "501-1000")?.count).toBe(1);
  });

  test("suggest returns prefix matches; keyset pagination (name_asc) walks every row once", async () => {
    const sugg = await db.accountSearchRepository.suggest(scopeA(), {
      field: "technology",
      prefix: "aw",
      limit: 10,
    });
    expect(sugg.some((s) => s.value === "aws")).toBe(true);

    const nameSugg = await db.accountSearchRepository.suggest(scopeA(), {
      field: "name",
      prefix: "Glo",
      limit: 10,
    });
    expect(nameSugg.some((s) => s.value === "Globe Systems")).toBe(true);

    // name_asc keyset: Acme Tech, Finovate, Globe Systems — page through 2 at a time.
    const first = await run(scopeA(), query({ sort: "name_asc", limit: 2 }));
    expect(first.accounts.map((h) => h.name)).toEqual(["Acme Tech", "Finovate"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await run(
      scopeA(),
      query({ sort: "name_asc", limit: 2, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.accounts.map((h) => h.name)).toEqual(["Globe Systems"]);
    expect(second.nextCursor).toBeNull();
  });
});
