// suppressionExport.itest.ts — the set-based suppression filter that gates the MASKED CSV export
// (08-architecture invariant 3: "suppression checked at every egress"; 09 § Data-subject rights; outcome S-11).
//
// Why this file exists: the REVEALED export was already safe, because it routes every row through
// revealContact and inherits that path's suppression gate. The MASKED export bypassed the gate entirely — and
// masked is not anonymous. It carries name, job title, company domain and location, which is personal data
// about someone who asked us to stop.
//
// The rung that matters most here is the EMAIL BLIND INDEX. A filter matching only on suppression_list.contact_id
// would pass every test written with a contact-scoped suppression row and still miss the common real case: a
// person suppressed by email, whose copy in this workspace has no suppression row of its own. That is the
// assertion this file is built around.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantId = "";
let wsId = "";
let userId = "";

// One contact per suppression rung, plus a control that must survive.
let byContactId = "";
let byEmailIndex = "";
let byDomain = "";
let clean = "";

const SUPPRESSED_INDEX = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

async function makeContact(firstName: string, blindIndex: Uint8Array | null, domain: string) {
  const [row] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, email_blind_index, email_domain)
    VALUES (${tenantId}, ${wsId}, ${firstName}, ${blindIndex}, ${domain})
    RETURNING id`;
  return (row as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("suppressionExport");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  userId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${userId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${userId}) RETURNING id`;
  wsId = (w as { id: string }).id;

  byContactId = await makeContact("ByContact", new Uint8Array([1, 1, 1, 1]), "one.test");
  byEmailIndex = await makeContact("ByEmail", SUPPRESSED_INDEX, "two.test");
  byDomain = await makeContact("ByDomain", new Uint8Array([3, 3, 3, 3]), "blocked.test");
  clean = await makeContact("Clean", new Uint8Array([4, 4, 4, 4]), "four.test");

  // One suppression row per rung.
  await admin`
    INSERT INTO suppression_list (scope, tenant_id, workspace_id, match_type, contact_id, reason)
    VALUES ('workspace', ${tenantId}, ${wsId}, 'contact_id', ${byContactId}, 'opt_out')`;
  await admin`
    INSERT INTO suppression_list (scope, tenant_id, workspace_id, match_type, email_blind_index, reason)
    VALUES ('workspace', ${tenantId}, ${wsId}, 'email', ${SUPPRESSED_INDEX}, 'opt_out')`;
  await admin`
    INSERT INTO suppression_list (scope, match_type, domain, reason)
    VALUES ('global', 'domain', 'blocked.test', 'dnc')`;

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("suppressedContactIds — the export egress filter", () => {
  test("catches all three rungs and spares the control", async () => {
    const ids = await dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
      dbmod.suppressionRepository.suppressedContactIds(tx, [
        byContactId,
        byEmailIndex,
        byDomain,
        clean,
      ]),
    );
    // The email rung is the one a contact_id-only filter would miss, and it is the common real case.
    expect(ids.has(byEmailIndex)).toBe(true);
    expect(ids.has(byContactId)).toBe(true);
    expect(ids.has(byDomain)).toBe(true);
    expect(ids.has(clean)).toBe(false);
    expect(ids.size).toBe(3);
  });

  test("a global suppression row gates a tenant that never created it", async () => {
    // blocked.test was inserted with scope 'global' and no tenant/workspace. If RLS or the join silently
    // narrowed to workspace-owned rows, a platform-wide DNC entry would stop applying to anyone.
    const ids = await dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
      dbmod.suppressionRepository.suppressedContactIds(tx, [byDomain]),
    );
    expect(ids.has(byDomain)).toBe(true);
  });

  test("an empty selection performs no query and returns nothing", async () => {
    const ids = await dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
      dbmod.suppressionRepository.suppressedContactIds(tx, []),
    );
    expect(ids.size).toBe(0);
  });

  test("a contact with no email keys is never suppressed by a NULL match", async () => {
    // The trap in an OR-joined matcher: a suppression row with a NULL blind index must not match every
    // contact whose blind index is also NULL. SQL NULL comparison saves us, and the IS NOT NULL guards make
    // that explicit rather than incidental — but only a test proves the whole predicate composes correctly.
    const noKeys = await makeContact("NoKeys", null, "");
    const ids = await dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
      dbmod.suppressionRepository.suppressedContactIds(tx, [noKeys, clean]),
    );
    expect(ids.size).toBe(0);
  });

  test("two suppression rows for one contact still yield one entry", async () => {
    // selectDistinct matters because the OR-join can match the SAME contact through more than one rung — and
    // the export audit COUNTS what was excluded, so a duplicated row would inflate that number and make a
    // compliance figure wrong in the direction that looks worse than reality.
    await admin`
      INSERT INTO suppression_list (scope, tenant_id, workspace_id, match_type, email_blind_index, reason)
      VALUES ('workspace', ${tenantId}, ${wsId}, 'email', ${new Uint8Array([1, 1, 1, 1])}, 'second_rung')`;

    const ids = await dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
      dbmod.suppressionRepository.suppressedContactIds(tx, [byContactId]),
    );
    // byContactId now matches on BOTH contact_id and email_blind_index.
    expect(ids.size).toBe(1);
  });
});
