// accountChildren.dualwrite.itest.ts — S-A2's test gate (import-and-data-model-redesign 06 §Testing,
// 15 §T-P4): the account-domain DUAL-WRITE PARITY harness + the collision + never-flip proofs, end to end
// against a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its
// OWN process: `bun test ./packages/db/test/accountChildren.dualwrite.itest.ts`
//
// GATE ARMS (the channel dualwrite precedent): the frozen config env cannot flip mid-process, so
// ACCOUNT_DOMAINS_DUAL_WRITE="true" is set for the WHOLE process and the on/off comparison rides the PER-TENANT
// flag half of the dual gate: tenant OFF keeps the 0062 seed (off/off ⇒ effective off), tenant ON gets a
// tenant_feature_flags override. Proves the flag layer alone holds the line even with the env layer armed;
// the env-off short-circuit (zero queries) is asserted indirectly (the OFF tenant writes zero child rows).
//
// PROVEN, per 06 §1:
//   1. PARITY: the SAME import → idempotent re-import sequence lands an IDENTICAL flat accounts end-state in
//      both arms (dual-write adds child rows, never behavior); gate-off writes ZERO account_domains rows.
//   2. Gate-on: one live is_primary domain row per account, `domain` == the flat accounts.domain cache,
//      source='import', lineage stamped; three contacts / two domains ⇒ two accounts ⇒ two domain rows
//      (dedup: a re-import appends nothing).
//   3. Collision (06 §1 "match signal, never an error"): attaching a domain live on ANOTHER account ⇒
//      `collision` outcome, NO row moved, no error.
//   4. Never-flip (06 §1 asymmetry 2): attaching a NEW domain to an account with a live primary appends a
//      SECONDARY; the primary + the flat cache are untouched.
//
// Core is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep here is a Turbo
// build cycle (the contactChannels.dualwrite precedent).

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

// Jane + John share acme.com (⇒ one account); Uma is globex.com (⇒ a second account).
const ROWS = [
  { Email: "jane@acme.com", "First Name": "Jane", Company: "Acme", Domain: "acme.com" },
  { Email: "john@acme.com", "First Name": "John", Company: "Acme", Domain: "acme.com" },
  { Email: "uma@globex.com", "First Name": "Uma", Company: "Globex", Domain: "globex.com" },
];

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

interface FlatAccount {
  name: string;
  domain: string | null;
}

/** The flat accounts end-state per workspace, ordered by domain (deterministic). */
async function flatAccounts(workspaceId: string): Promise<FlatAccount[]> {
  const rows = await admin`
    SELECT name, domain::text AS domain FROM accounts
    WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY domain`;
  return rows as unknown as FlatAccount[];
}

async function domainRowCount(workspaceId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM account_domains
    WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  return (r as { n: number }).n;
}

async function accountIdByDomain(workspaceId: string, domain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM accounts WHERE workspace_id = ${workspaceId} AND domain = ${domain}`;
  return (r as { id: string }).id;
}

async function runSequence(scope: { tenantId: string; workspaceId: string }, ownerId: string) {
  const first = await core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: ROWS,
  });
  expect(first.created).toBe(3);
  // Idempotent re-import (identical rows ⇒ same content hash ⇒ skipped): appends no domain row (dedup).
  await core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: ROWS,
  });
}

beforeAll(async () => {
  dbHandle = await startItestDb("account_children_dualwrite");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.ACCOUNT_DOMAINS_DUAL_WRITE = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantOff, workspaceId: wsOff, ownerId: ownerOff } =
    await seedTenantWorkspace("acme-off"));
  ({ tenantId: tenantOn, workspaceId: wsOn, ownerId: ownerOn } =
    await seedTenantWorkspace("acme-on"));
  // The ON tenant's per-tenant override; the OFF tenant keeps the 0062 seed (off/off ⇒ effective off).
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES ('account_domains_dual_write', ${tenantOn}, true)`;

  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");

  await runSequence({ tenantId: tenantOff, workspaceId: wsOff }, ownerOff);
  await runSequence({ tenantId: tenantOn, workspaceId: wsOn }, ownerOn);
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeOn = () => ({ tenantId: tenantOn, workspaceId: wsOn });

describe("T-P4 — dual-write parity (gate off vs on ⇒ identical flat accounts; child rows only gate-on)", () => {
  test("the identical import sequence lands an identical flat accounts end-state in both arms", async () => {
    const off = await flatAccounts(wsOff);
    const on = await flatAccounts(wsOn);
    expect(off.length).toBe(2);
    expect(on.length).toBe(2);
    for (let i = 0; i < off.length; i++) {
      expect(on[i]!.domain).toBe(off[i]!.domain);
      expect(on[i]!.name).toBe(off[i]!.name);
    }
  });

  test("gate-off (flag-off tenant): ZERO account_domains rows were written", async () => {
    expect(await domainRowCount(wsOff)).toBe(0);
  });

  test("gate-on: one live is_primary domain row per account, cache-equal, lineage stamped (dedup ⇒ 2 rows)", async () => {
    const rows = await admin`
      SELECT a.domain::text AS acct_domain, ad.domain::text AS child_domain, ad.is_primary,
             ad.source, (ad.source_import_id IS NOT NULL) AS has_lineage, ad.pinned
      FROM account_domains ad JOIN accounts a ON a.id = ad.account_id
      WHERE ad.workspace_id = ${wsOn} AND ad.deleted_at IS NULL ORDER BY ad.domain`;
    expect(rows.length).toBe(2); // three contacts / two domains ⇒ two accounts ⇒ two primary rows
    for (const r of rows as unknown as Array<Record<string, unknown>>) {
      expect(r.is_primary).toBe(true);
      expect(r.child_domain).toBe(r.acct_domain); // the flat accounts.domain cache == the primary child
      expect(r.source).toBe("import");
      expect(r.has_lineage).toBe(true);
      expect(r.pinned).toBe(false);
    }
  });
});

describe("06 §1 — collision + never-flip at the applyAccountDomainWrite layer", () => {
  test("a domain live on ANOTHER account ⇒ `collision`, no row moved, no error", async () => {
    const globexId = await accountIdByDomain(wsOn, "globex.com");
    // acme.com is live on the acme account; replaying it against globex must not move it (06 §Edge).
    const outcome = await db.withTenantTx(scopeOn(), (tx) =>
      db.accountChildRepository.applyAccountDomainWrite(tx, scopeOn(), {
        kind: "domain_upsert",
        accountId: globexId,
        value: { domain: "acme.com", source: "manual" },
      }),
    );
    expect(outcome.result).toBe("collision");
    // globex still owns exactly its own one live domain; acme.com never moved.
    const [n] = await admin`
      SELECT count(*)::int AS n FROM account_domains
      WHERE account_id = ${globexId} AND deleted_at IS NULL`;
    expect((n as { n: number }).n).toBe(1);
    const [owner] = await admin`
      SELECT account_id FROM account_domains WHERE workspace_id = ${wsOn} AND domain = 'acme.com' AND deleted_at IS NULL`;
    expect((owner as { account_id: string }).account_id).toBe(await accountIdByDomain(wsOn, "acme.com"));
  });

  test("attaching a NEW domain to an account with a live primary ⇒ SECONDARY; primary + flat cache untouched", async () => {
    const acmeId = await accountIdByDomain(wsOn, "acme.com");
    const outcome = await db.withTenantTx(scopeOn(), (tx) =>
      db.accountChildRepository.applyAccountDomainWrite(tx, scopeOn(), {
        kind: "domain_upsert",
        accountId: acmeId,
        value: { domain: "acme.io", source: "manual" },
      }),
    );
    expect(outcome.result).toBe("inserted");
    if (outcome.result === "inserted") expect(outcome.becamePrimary).toBe(false);

    const rows = await admin`
      SELECT domain::text AS domain, is_primary FROM account_domains
      WHERE account_id = ${acmeId} AND deleted_at IS NULL ORDER BY is_primary DESC`;
    expect(rows.length).toBe(2);
    const [primary, secondary] = rows as unknown as Array<Record<string, unknown>>;
    expect(primary!.domain).toBe("acme.com"); // the ORIGINAL primary — never flipped
    expect(primary!.is_primary).toBe(true);
    expect(secondary!.domain).toBe("acme.io");
    expect(secondary!.is_primary).toBe(false);
    // The flat cache still holds the primary — a secondary attach never rewrites accounts.domain.
    const [flat] = await admin`SELECT domain::text AS domain FROM accounts WHERE id = ${acmeId}`;
    expect((flat as { domain: string }).domain).toBe("acme.com");
  });
});
