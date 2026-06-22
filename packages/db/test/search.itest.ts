// search.itest.ts — Definition-of-Done for the Postgres SearchPort adapter (searchRepository, 24/ADR-0035) on
// a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — itestDb.ts). Run in its OWN process:
//   `bun test ./packages/db/test/search.itest.ts`
//
// Proves the faceted, owner-scoped query path:
//   (1) workspace isolation — workspace B's contacts never surface in A (RLS via withTenantTx);
//   (2) the owner facet ("My prospects") returns only the caller's owned rows;
//   (3) term include/exclude, boolean data signals (has_email/duplicate/never_contacted), numeric ranges
//       (score), account-join facets, and free-text all filter correctly;
//   (4) live facet counts group per value and IGNORE the facet's own term filter (Apollo behaviour);
//   (5) suggest returns prefix matches; keyset pagination walks every row without overlap.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Types = typeof import("@leadwolf/types");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let _types: Types;

let tenantA = "";
let wsA = "";
let ownerA = "";
let coworkerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";
let acctA = "";
// A-workspace contacts
let cCeo = "";
let cSwe = "";
let cVp = "";

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

interface ContactSeed {
  ws: { tenantId: string; workspaceId: string };
  owner: string;
  firstName: string;
  jobTitle?: string;
  seniority?: string;
  outreachStatus?: string;
  score?: number;
  hasEmail?: boolean;
  accountId?: string | null;
  duplicateOf?: string | null;
  createdAt?: string;
}

async function seedContact(s: ContactSeed): Promise<string> {
  const emailEnc = s.hasEmail ? Buffer.from([1, 2, 3]) : null;
  const [c] = await admin`
    INSERT INTO contacts (
      tenant_id, workspace_id, owner_user_id, account_id, first_name, job_title, seniority_level,
      outreach_status, priority_score, email_enc, duplicate_of_contact_id, created_at
    ) VALUES (
      ${s.ws.tenantId}, ${s.ws.workspaceId}, ${s.owner}, ${s.accountId ?? null}, ${s.firstName},
      ${s.jobTitle ?? null}, ${s.seniority ?? null}, ${s.outreachStatus ?? "new"},
      ${s.score ?? null}, ${emailEnc}, ${s.duplicateOf ?? null}, ${s.createdAt ?? "2026-01-01T00:00:00Z"}
    ) RETURNING id`;
  return (c as { id: string }).id;
}

const query = (over: Record<string, unknown> = {}) => ({
  filters: [],
  sort: "relevance" as const,
  limit: 50,
  ...over,
});

beforeAll(async () => {
  dbHandle = await startItestDb("search");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedTenantWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedTenantWorkspace("globex"));
  coworkerA = await seedUser("coworker@acme.test");

  const [a] = await admin`
    INSERT INTO accounts (tenant_id, workspace_id, name, domain, industry, employee_count, technologies)
    VALUES (${tenantA}, ${wsA}, 'Acme Tech', 'acme.test', 'Software', 100, '["salesforce","aws"]'::jsonb)
    RETURNING id`;
  acctA = (a as { id: string }).id;

  const A = { tenantId: tenantA, workspaceId: wsA };
  cCeo = await seedContact({
    ws: A,
    owner: ownerA,
    firstName: "Cary",
    jobTitle: "Chief Executive Officer",
    seniority: "c_suite",
    outreachStatus: "new",
    score: 90,
    hasEmail: true,
    accountId: acctA,
    createdAt: "2026-01-03T00:00:00Z",
  });
  cSwe = await seedContact({
    ws: A,
    owner: coworkerA,
    firstName: "Sam",
    jobTitle: "Software Engineer",
    seniority: "ic",
    outreachStatus: "replied",
    score: 40,
    hasEmail: false,
    createdAt: "2026-01-02T00:00:00Z",
  });
  cVp = await seedContact({
    ws: A,
    owner: ownerA,
    firstName: "Val",
    jobTitle: "VP Sales",
    seniority: "vp",
    score: 70,
    hasEmail: false,
    duplicateOf: cCeo,
    createdAt: "2026-01-01T00:00:00Z",
  });
  await seedContact({
    ws: { tenantId: tenantB, workspaceId: wsB },
    owner: ownerB,
    firstName: "Bob",
    jobTitle: "CEO",
  });

  db = await import("@leadwolf/db");
  _types = await import("@leadwolf/types");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

// biome-ignore lint/suspicious/noExplicitAny: the itest passes plain query literals to the repo.
const run = (scope: ReturnType<typeof scopeA>, q: Record<string, unknown>) =>
  db.searchRepository.searchContacts(scope, q as any);

describe("Postgres searchRepository — owner-scoped faceted search (24)", () => {
  test("workspace isolation: B's contacts never surface in A and vice-versa", async () => {
    const a = await run(scopeA(), query());
    const aIds = a.hits.map((h) => h.id);
    expect(aIds.sort()).toEqual([cCeo, cSwe, cVp].sort());
    const b = await run(scopeB(), query());
    expect(b.hits.every((h) => aIds.includes(h.id))).toBe(false);
    expect(b.hits).toHaveLength(1); // only Bob
  });

  test("the owner facet returns only the caller's owned rows", async () => {
    const a = await run(
      scopeA(),
      query({ filters: [{ kind: "term", field: "owner", op: "include", values: [ownerA] }] }),
    );
    expect(a.hits.map((h) => h.id).sort()).toEqual([cCeo, cVp].sort()); // not Sam (coworkerA's)
  });

  test("term include/exclude on seniority", async () => {
    const inc = await run(
      scopeA(),
      query({
        filters: [{ kind: "term", field: "seniority", op: "include", values: ["c_suite", "vp"] }],
      }),
    );
    expect(inc.hits.map((h) => h.id).sort()).toEqual([cCeo, cVp].sort());
    const exc = await run(
      scopeA(),
      query({ filters: [{ kind: "term", field: "seniority", op: "exclude", values: ["ic"] }] }),
    );
    expect(exc.hits.map((h) => h.id).sort()).toEqual([cCeo, cVp].sort());
  });

  test("boolean signals: has_email, duplicate, never_contacted", async () => {
    const withEmail = await run(
      scopeA(),
      query({ filters: [{ kind: "bool", field: "has_email", value: true }] }),
    );
    expect(withEmail.hits.map((h) => h.id)).toEqual([cCeo]);

    const dupes = await run(
      scopeA(),
      query({ filters: [{ kind: "bool", field: "duplicate", value: true }] }),
    );
    expect(dupes.hits.map((h) => h.id)).toEqual([cVp]); // duplicate_of_contact_id set

    const never = await run(
      scopeA(),
      query({ filters: [{ kind: "bool", field: "never_contacted", value: true }] }),
    );
    expect(never.hits.map((h) => h.id).sort()).toEqual([cCeo, cSwe, cVp].sort()); // no outreach_log rows
  });

  test("numeric range on score + account-join facet (industry) + free-text", async () => {
    const hi = await run(
      scopeA(),
      query({ filters: [{ kind: "range", field: "score", gte: 80 }] }),
    );
    expect(hi.hits.map((h) => h.id)).toEqual([cCeo]);

    const soft = await run(scopeA(), query({ text: "software" }));
    expect(soft.hits.map((h) => h.id)).toEqual([cSwe]);
  });

  test("live facet counts group per value and ignore the facet's own term filter", async () => {
    const owners = await db.searchRepository.facetCounts(scopeA(), query() as never, ["owner"]);
    expect(owners.find((f) => f.value === ownerA)?.count).toBe(2);
    expect(owners.find((f) => f.value === coworkerA)?.count).toBe(1);

    // Even with a seniority filter active, the seniority facet still reports all three values (Apollo style).
    const seniority = await db.searchRepository.facetCounts(
      scopeA(),
      query({
        filters: [{ kind: "term", field: "seniority", op: "include", values: ["vp"] }],
      }) as never,
      ["seniority"],
    );
    expect(seniority.map((f) => f.value).sort()).toEqual(["c_suite", "ic", "vp"]);

    const industry = await db.searchRepository.facetCounts(scopeA(), query() as never, [
      "industry",
    ]);
    expect(industry.find((f) => f.value === "Software")?.count).toBe(1);
  });

  test("suggest returns prefix matches; keyset pagination walks every row once", async () => {
    const sugg = await db.searchRepository.suggest(scopeA(), {
      field: "title",
      prefix: "soft",
      limit: 10,
      scope: "workspace",
    });
    expect(sugg.some((s) => s.value === "Software Engineer")).toBe(true);

    const first = await run(scopeA(), query({ limit: 2 }));
    expect(first.hits.map((h) => h.id)).toEqual([cCeo, cSwe]); // created_at desc
    expect(first.nextCursor).toBeTruthy();
    const second = await run(scopeA(), query({ limit: 2, cursor: first.nextCursor }));
    expect(second.hits.map((h) => h.id)).toEqual([cVp]);
    expect(second.nextCursor).toBeNull();
  });
});
