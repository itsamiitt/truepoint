// accountChildren.backfill.itest.ts — S-A1/S-A3's test gate (import-and-data-model-redesign 06 §Testing
// "backfill idempotency", 15 §T-P4 / §2.2): the account backfill against a real Postgres 16 (Testcontainers by
// default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process:
// `bun test ./packages/db/test/accountChildren.backfill.itest.ts`
//
// What is proven, per 15 §2.2:
//   1. DOMAIN pass (S-A1 re-run): a flat-only account (domain, no child) gets its is_primary domain child,
//      `domain` BYTE-EQUAL to the flat accounts.domain (the flat cache is NEVER rewritten), source='import'.
//   2. HQ pass (S-A3, best-effort): a mappable hq_country → ISO alpha-2 (US); an UNMAPPABLE freetext hq_country
//      → country NULL with the city carried (06 §3/§4 honesty), the row STILL written + counted.
//   3. Idempotency: re-run ⇒ zero new rows (twice = once; the WHERE-missing selection is the watermark).
//   4. THE S-A6/C2 GATE: countAccountsMissingDomainChild() drains to 0 once every domained account is
//      backfilled — the precondition C2 (07 §8 edge; 15 seq 55) must not activate before.
//   5. Fail-closed gate: a tenant with the flag OFF ⇒ gateOff, ZERO writes (tenant selection + batch abort).
//
// Env: ACCOUNT_DOMAINS_DUAL_WRITE="true" for the whole process (frozen config); the per-tenant
// `account_domains_dual_write` flag drives on/off arms. Core via the RELATIVE barrel (build-cycle avoidance).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

let tOn = "";
let wsOn = "";
let tOff = "";
let wsOff = "";

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id };
}

/** Seed a flat-only account (no child rows) — the pre-dual-write state the backfill converges. */
async function seedAccount(
  tenantId: string,
  workspaceId: string,
  fields: { name: string; domain: string | null; hqCountry: string | null; hqCity: string | null },
): Promise<string> {
  const [a] = await admin`
    INSERT INTO accounts (tenant_id, workspace_id, name, domain, hq_country, hq_city)
    VALUES (${tenantId}, ${workspaceId}, ${fields.name}, ${fields.domain}, ${fields.hqCountry}, ${fields.hqCity})
    RETURNING id`;
  return (a as { id: string }).id;
}

const scope = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId });

async function domainRows(workspaceId: string) {
  return (await admin`
    SELECT a.domain::text AS acct_domain, ad.domain::text AS child_domain, ad.is_primary, ad.source
    FROM account_domains ad JOIN accounts a ON a.id = ad.account_id
    WHERE ad.workspace_id = ${workspaceId} AND ad.deleted_at IS NULL
    ORDER BY ad.domain`) as unknown as Array<Record<string, unknown>>;
}
async function locationRows(workspaceId: string) {
  return (await admin`
    SELECT type, city, country, is_primary, source FROM account_locations
    WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY city`) as unknown as Array<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  dbHandle = await startItestDb("account_children_backfill");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.ACCOUNT_DOMAINS_DUAL_WRITE = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tOn, workspaceId: wsOn } = await seedTenantWorkspace("bf-on"));
  ({ tenantId: tOff, workspaceId: wsOff } = await seedTenantWorkspace("bf-off"));
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES ('account_domains_dual_write', ${tOn}, true)`;

  // ON tenant: A (mappable HQ), B (unmappable HQ), D (domain only); C is domainless + hq-less (untouched).
  await seedAccount(tOn, wsOn, {
    name: "Acme",
    domain: "acme.com",
    hqCountry: "United States",
    hqCity: "New York",
  });
  await seedAccount(tOn, wsOn, {
    name: "Globex",
    domain: "globex.com",
    hqCountry: "Freedonia", // deliberately unmappable freetext
    hqCity: "Sylvania",
  });
  await seedAccount(tOn, wsOn, { name: "Initech", domain: "initech.com", hqCountry: null, hqCity: null });
  await seedAccount(tOn, wsOn, { name: "Ghost", domain: null, hqCountry: null, hqCity: null });
  // OFF tenant: one domained + HQ account (the fail-closed arm).
  await seedAccount(tOff, wsOff, {
    name: "Umbrella",
    domain: "umbrella.com",
    hqCountry: "France",
    hqCity: "Paris",
  });

  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-A1/S-A3 account backfill — domain + HQ passes, idempotency, the C2 gate, fail-closed", () => {
  test("before any backfill the fleet gate counts every domained account (A,B,D,E = 4)", async () => {
    expect(await db.accountChildRepository.countAccountsMissingDomainChild()).toBe(4);
  });

  test("domain pass: one is_primary child per domained account, BYTE-EQUAL to the flat cache, source='import'", async () => {
    const res = await core.runAccountBackfillForWorkspace(scope(tOn, wsOn));
    expect(res.gateOff).toBe(false);
    expect(res.domainsCreated).toBe(3); // acme, globex, initech (Ghost is domainless)
    const rows = await domainRows(wsOn);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.is_primary).toBe(true);
      expect(r.child_domain).toBe(r.acct_domain); // the flat cache is the source projected FROM — never rewritten
      expect(r.source).toBe("import"); // NOT 'backfill' (the CHECK forbids it; 06 S-A1 pins 'import')
    }
  });

  test("HQ pass: mappable country → ISO (US); UNMAPPABLE freetext → country NULL + city carried (06 §3)", async () => {
    const rows = await locationRows(wsOn);
    expect(rows.length).toBe(2); // acme (New York/US), globex (Sylvania/NULL); initech/ghost have no hq
    const ny = rows.find((r) => r.city === "New York")!;
    expect(ny.type).toBe("hq");
    expect(ny.is_primary).toBe(true);
    expect(ny.country).toBe("US"); // "United States" mapped confidently
    const syl = rows.find((r) => r.city === "Sylvania")!;
    expect(syl.country).toBeNull(); // "Freedonia" unmappable ⇒ NULL, but the row is STILL written (city carried)
    expect(syl.type).toBe("hq");
  });

  test("idempotency: a second pass creates ZERO new rows (twice = once)", async () => {
    const res = await core.runAccountBackfillForWorkspace(scope(tOn, wsOn));
    expect(res.domainsCreated).toBe(0);
    expect(res.hqCreated).toBe(0);
    expect((await domainRows(wsOn)).length).toBe(3);
    expect((await locationRows(wsOn)).length).toBe(2);
  });

  test("the ON tenant is fully backfilled; only the OFF tenant's account remains in the fleet gate", async () => {
    expect(await db.accountChildRepository.countAccountsMissingDomainChild()).toBe(1); // umbrella (off)
  });

  test("fail-closed: the OFF tenant runner returns gateOff and writes NOTHING", async () => {
    const res = await core.runAccountBackfillForWorkspace(scope(tOff, wsOff));
    expect(res.gateOff).toBe(true);
    expect(res.domainsCreated).toBe(0);
    expect((await domainRows(wsOff)).length).toBe(0);
    expect((await locationRows(wsOff)).length).toBe(0);
  });

  test("THE C2 GATE reaches 0 once the last tenant is enabled + backfilled", async () => {
    await admin`
      INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
      VALUES ('account_domains_dual_write', ${tOff}, true)`;
    const res = await core.runAccountBackfillForWorkspace(scope(tOff, wsOff));
    expect(res.gateOff).toBe(false);
    expect(res.domainsCreated).toBe(1);
    expect(await db.accountChildRepository.countAccountsMissingDomainChild()).toBe(0); // C2 precondition met
    expect(await db.accountChildRepository.countAccountsMissingHqLocation()).toBe(0);
  });
});
