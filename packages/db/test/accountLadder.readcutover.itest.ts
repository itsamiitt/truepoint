// accountLadder.readcutover.itest.ts — S-A6's test gate (import-and-data-model-redesign 06 §5/§6/§API; 15
// §T-P4 "ladder property tests" + "flag-off byte-identity"): the company-match ladder rung C2, the
// account-detail overlay read projection, and the tombstone read exclusion — end to end against a real
// Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process:
// `bun test ./packages/db/test/accountLadder.readcutover.itest.ts`.
//
// GATE ARMS (the channel/account dualwrite precedent): the frozen config env cannot flip mid-process, so BOTH
// ACCOUNT_DOMAINS_DUAL_WRITE="true" AND ACCOUNT_READ_FROM_CHILD="true" are set for the WHOLE process; the
// on/off comparison rides the PER-TENANT `account_read_from_child` flag. BOTH tenants dual-write (child rows
// exist in both); ONLY the ON tenant has the read flag → the C2 difference is isolated to the READ gate.
//
// PROVEN:
//   1. C2 gate-ON (06 §5): a row whose domain is a live SECONDARY of an existing account RESOLVES to that
//      account — no duplicate is minted (the G17 payoff).
//   2. C2 gate-OFF byte-identical: the same sequence with the read flag off is C1-only — the secondary domain
//      mints a SEPARATE account (the shipped pre-S-A6 behavior).
//   3. Overlay projection (06 §API): overlayExtensionsForAccounts returns the live domains[] (primary first),
//      and is workspace-walled by RLS (a foreign accountId yields nothing).
//   4. Tombstone read exclusion (06 §4): accountSearchRepository excludes soft-deleted accounts.
//
// Core (runImport) is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep here is
// a Turbo build cycle (the accountChildren.dualwrite precedent).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

let tenantOff = "";
let wsOff = "";
let ownerOff = "";
let tenantOn = "";
let wsOn = "";
let ownerOn = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  accountName: "Company",
  accountDomain: "Domain",
};

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

async function liveAccountCount(workspaceId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM accounts WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  return (r as { n: number }).n;
}

async function accountIdByDomain(workspaceId: string, domain: string): Promise<string> {
  const [r] = await admin`
    SELECT id::text AS id FROM accounts WHERE workspace_id = ${workspaceId} AND domain = ${domain} AND deleted_at IS NULL`;
  return (r as { id: string }).id;
}

async function accountIdOfContact(workspaceId: string, firstName: string): Promise<string | null> {
  const [r] = await admin`
    SELECT account_id::text AS account_id FROM contacts WHERE workspace_id = ${workspaceId} AND first_name = ${firstName}`;
  return (r as { account_id: string | null }).account_id;
}

function importRow(
  scope: { tenantId: string; workspaceId: string },
  ownerId: string,
  row: Record<string, string>,
) {
  return core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: [row],
  });
}

/** Per-tenant setup: create Acme(acme.com), attach the SECONDARY acme.io, then import a row on acme.io. */
async function setupTenant(
  scope: { tenantId: string; workspaceId: string },
  ownerId: string,
): Promise<void> {
  await importRow(scope, ownerId, {
    Email: "jane@acme.com",
    "First Name": "Jane",
    Company: "Acme",
    Domain: "acme.com",
  });
  const acmeId = await accountIdByDomain(scope.workspaceId, "acme.com");
  // Attach acme.io as a live SECONDARY of Acme (a manual attach — the exact whole-set state C2 keys on).
  await db.withTenantTx(scope, (tx) =>
    db.accountChildRepository.applyAccountDomainWrite(tx, scope, {
      kind: "domain_upsert",
      accountId: acmeId,
      value: { domain: "acme.io", source: "manual" },
    }),
  );
  // Import a contact carrying the SECONDARY domain acme.io.
  await importRow(scope, ownerId, {
    Email: "bob@acme.io",
    "First Name": "Bob",
    Company: "Acme",
    Domain: "acme.io",
  });
}

beforeAll(async () => {
  dbHandle = await startItestDb("account_ladder_readcutover");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.ACCOUNT_DOMAINS_DUAL_WRITE = "true";
  process.env.ACCOUNT_READ_FROM_CHILD = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantOff, workspaceId: wsOff, ownerId: ownerOff } =
    await seedTenantWorkspace("ladder-off"));
  ({ tenantId: tenantOn, workspaceId: wsOn, ownerId: ownerOn } =
    await seedTenantWorkspace("ladder-on"));
  // BOTH dual-write; only the ON tenant reads from child (⇒ only it gets rung C2).
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled) VALUES
      ('account_domains_dual_write', ${tenantOff}, true),
      ('account_domains_dual_write', ${tenantOn}, true),
      ('account_read_from_child', ${tenantOn}, true)`;

  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");

  await setupTenant({ tenantId: tenantOff, workspaceId: wsOff }, ownerOff);
  await setupTenant({ tenantId: tenantOn, workspaceId: wsOn }, ownerOn);
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeOn = () => ({ tenantId: tenantOn, workspaceId: wsOn });
const scopeOff = () => ({ tenantId: tenantOff, workspaceId: wsOff });

describe("06 §5 — ladder rung C2 (any-live-secondary-domain exact)", () => {
  test("gate-ON: a secondary-domain row resolves to the existing account (NO duplicate minted)", async () => {
    expect(await liveAccountCount(wsOn)).toBe(1); // still just Acme — acme.io did not mint a second account
    const acme = await accountIdByDomain(wsOn, "acme.com");
    expect(await accountIdOfContact(wsOn, "Bob")).toBe(acme); // Bob landed on Acme via C2
  });

  test("gate-OFF byte-identical: C1-only ⇒ the secondary domain mints a SEPARATE account", async () => {
    expect(await liveAccountCount(wsOff)).toBe(2); // acme.com + acme.io are two distinct accounts
    const acmeCom = await accountIdByDomain(wsOff, "acme.com");
    const acmeIo = await accountIdByDomain(wsOff, "acme.io");
    expect(acmeIo).not.toBe(acmeCom);
    expect(await accountIdOfContact(wsOff, "Bob")).toBe(acmeIo); // Bob landed on the NEW acme.io account
  });
});

describe("06 §API — account-detail overlay projection (RLS-walled)", () => {
  test("own workspace: live domains resolve, primary first", async () => {
    const acme = await accountIdByDomain(wsOn, "acme.com");
    const proj = await db.withTenantTx(scopeOn(), (tx) =>
      db.accountChildRepository.overlayExtensionsForAccounts(tx, [acme]),
    );
    const entry = proj.get(acme);
    expect(entry).toBeDefined();
    expect(entry!.domains.map((d) => d.domain).sort()).toEqual(["acme.com", "acme.io"]);
    expect(entry!.domains[0]!.isPrimary).toBe(true); // primary (acme.com) ordered first
  });

  test("cross-workspace: a foreign accountId yields nothing (RLS non-leak)", async () => {
    const acmeOn = await accountIdByDomain(wsOn, "acme.com");
    const proj = await db.withTenantTx(scopeOff(), (tx) =>
      db.accountChildRepository.overlayExtensionsForAccounts(tx, [acmeOn]),
    );
    expect(proj.get(acmeOn)).toBeUndefined();
  });
});

describe("06 §4 — tombstone read exclusion (behaviour-neutral until a delete verb writes deleted_at)", () => {
  test("accountSearchRepository excludes a soft-deleted account", async () => {
    // Two fresh accounts in the OFF workspace; one gets tombstoned by hand (no delete verb ships yet).
    await admin`INSERT INTO accounts (tenant_id, workspace_id, name, domain) VALUES (${tenantOff}, ${wsOff}, 'Ghost', 'ghost.example')`;
    await admin`INSERT INTO accounts (tenant_id, workspace_id, name, domain, deleted_at)
      VALUES (${tenantOff}, ${wsOff}, 'Zombie', 'zombie.example', now())`;
    const page = await db.accountSearchRepository.searchAccounts(scopeOff(), {
      filters: [],
      sort: "created_desc",
      limit: 200,
    });
    const names = page.accounts.map((a) => a.name);
    expect(names).toContain("Ghost");
    expect(names).not.toContain("Zombie");
    // countAccounts agrees with the page (the page/count agreement the exclusion threads through both).
    const total = await db.accountSearchRepository.countAccounts(scopeOff(), {
      filters: [],
      sort: "created_desc",
      limit: 200,
    });
    expect(total).toBe(page.accounts.length);
  });
});
