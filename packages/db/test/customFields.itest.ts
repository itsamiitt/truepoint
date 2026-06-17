// customFields.itest.ts — the Definition-of-Done proof for the record-customization layer (ADR-0028, gap
// G-REV-5) on a real Postgres 16 (Testcontainers by default, or external via ITEST_DATABASE_URL — see
// itestDb.ts). Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/customFields.itest.ts
//
// Proves: (1) a defined field appears in the workspace's definition list; (2) setting a value validates by
// type (a bad number/select is rejected) and persists (shallow-merge: a second set preserves untouched keys);
// (3) a null clears one key; (4) RLS — a wrong-workspace leadwolf_app session sees ZERO definitions; and
// (5) cross-workspace ISOLATION — workspace B (a DIFFERENT workspace) cannot read workspace A's definitions
// or A's contact custom_fields values through the scoped core/repository path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let appUrl = "";
let tenantA = "";
let wsA = "";
let wsB = "";
let ownerA = "";

type DbModule = typeof import("@leadwolf/db");
type CustomFieldRepoModule = typeof import("../src/repositories/customFieldRepository.ts");
let customFieldRepository: CustomFieldRepoModule["customFieldRepository"];

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
const ROWS_A = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
];
const ROWS_B = [
  {
    Email: "bob@globex.com",
    "First Name": "Bob",
    "Last Name": "Roe",
    Company: "Globex",
    Domain: "globex.com",
  },
];

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("customFields");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] =
    await admin`INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme','acme',10) RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [wa] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme-sales', 'acme-sales', true, ${ownerA}) RETURNING id`;
  wsA = (wa as { id: string }).id;
  const [wb] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme-mktg', 'acme-mktg', false, ${ownerA}) RETURNING id`;
  wsB = (wb as { id: string }).id;

  core = await import("../../core/src/index.ts");
  ({ customFieldRepository } = await import("../src/repositories/customFieldRepository.ts"));

  // Seed one contact in each workspace so values can be set/isolated.
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS_A,
  });
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsB },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS_B,
  });
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("ADR-0028 custom fields DoD", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("a defined field appears in the workspace's definition list", async () => {
    await core.createDefinition({
      scope: scopeA(),
      entity: "contact",
      key: "account_tier",
      label: "Account Tier",
      fieldType: "select",
      options: ["gold", "silver", "bronze"],
      required: false,
      ordering: 1,
    });
    await core.createDefinition({
      scope: scopeA(),
      entity: "contact",
      key: "renewal_count",
      label: "Renewal Count",
      fieldType: "number",
    });

    const defs = await core.listDefinitions(scopeA(), "contact");
    expect(defs.map((d) => d.key)).toEqual(["account_tier", "renewal_count"]);
    expect(defs[0]?.fieldType).toBe("select");
    expect(defs[0]?.options).toEqual(["gold", "silver", "bronze"]);
  });

  test("a duplicate key is rejected", async () => {
    const err = await core
      .createDefinition({
        scope: scopeA(),
        entity: "contact",
        key: "account_tier",
        label: "Dup",
        fieldType: "text",
      })
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(String(err)).toContain("account_tier");
  });

  test("setting a value validates by type and persists (shallow-merge preserves other keys)", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");

    // A bad select value is rejected (validateValue).
    const badSelect = await core
      .setCustomFieldValues({
        scope: scopeA(),
        entity: "contact",
        recordId: contactId,
        values: { account_tier: "platinum" },
      })
      .then(() => null)
      .catch((e) => e);
    expect(String(badSelect)).toContain("must be one of");

    // A bad number is rejected.
    const badNumber = await core
      .setCustomFieldValues({
        scope: scopeA(),
        entity: "contact",
        recordId: contactId,
        values: { renewal_count: "not-a-number" },
      })
      .then(() => null)
      .catch((e) => e);
    expect(String(badNumber)).toContain("must be a number");

    // Valid values persist.
    const set1 = await core.setCustomFieldValues({
      scope: scopeA(),
      entity: "contact",
      recordId: contactId,
      values: { account_tier: "gold", renewal_count: 3 },
    });
    const byKey1 = Object.fromEntries(set1.map((v) => [v.key, v.value]));
    expect(byKey1.account_tier).toBe("gold");
    expect(byKey1.renewal_count).toBe(3);
    // The value DTO carries the select field's options (so an editor can render a constrained dropdown).
    const tierDto = set1.find((v) => v.key === "account_tier");
    expect(tierDto?.options).toEqual(["gold", "silver", "bronze"]);

    // A second set touching only one key preserves the untouched key (shallow-merge).
    const set2 = await core.setCustomFieldValues({
      scope: scopeA(),
      entity: "contact",
      recordId: contactId,
      values: { renewal_count: 4 },
    });
    const byKey2 = Object.fromEntries(set2.map((v) => [v.key, v.value]));
    expect(byKey2.account_tier).toBe("gold"); // untouched, preserved
    expect(byKey2.renewal_count).toBe(4);

    // A null clears one key; the other remains.
    const set3 = await core.setCustomFieldValues({
      scope: scopeA(),
      entity: "contact",
      recordId: contactId,
      values: { renewal_count: null },
    });
    const byKey3 = Object.fromEntries(set3.map((v) => [v.key, v.value]));
    expect(byKey3.renewal_count).toBeNull();
    expect(byKey3.account_tier).toBe("gold");
  });

  test("RLS: a wrong-workspace leadwolf_app session sees zero definitions", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenWrong = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${crypto.randomUUID()}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM custom_field_definitions`;
        return (r as { n: number }).n;
      });
      expect(seenWrong).toBe(0);

      const seenRight = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM custom_field_definitions`;
        return (r as { n: number }).n;
      });
      expect(seenRight).toBe(2);
    } finally {
      await app.end();
    }
  });

  test("isolation: workspace B cannot read workspace A's definitions or values", async () => {
    const scopeB = { tenantId: tenantA, workspaceId: wsB };

    // B has no definitions of its own → A's two never leak across the workspace boundary.
    const defsB = await core.listDefinitions(scopeB, "contact");
    expect(defsB).toEqual([]);

    // B's own contact's values read back as B's (empty, since B defined nothing) — not A's gold/4.
    const contactB = await contactIdByDomain(wsB, "globex.com");
    const valuesB = await core.getCustomFieldValues(scopeB, "contact", contactB);
    expect(valuesB).toEqual([]);

    // And A's contact is invisible to B: a scoped read for A's contact id under B's scope is a 404, never A's data.
    const contactA = await contactIdByDomain(wsA, "acme.com");
    const crossRead = await core
      .getCustomFieldValues(scopeB, "contact", contactA)
      .then(() => null)
      .catch((e) => e);
    expect(crossRead).not.toBeNull();
    expect(String(crossRead)).toContain("not found");

    // Repository-level cross check: setting B-scoped values on A's contact must not touch A (404 path).
    const crossWrite = await core
      .setCustomFieldValues({
        scope: scopeB,
        entity: "contact",
        recordId: contactA,
        values: { renewal_count: 99 },
      })
      .then(() => null)
      .catch((e) => e);
    expect(String(crossWrite)).toContain("not found");

    // A's value is intact (still gold) — the cross-workspace write never landed.
    const valuesA = await core.getCustomFieldValues(
      { tenantId: tenantA, workspaceId: wsA },
      "contact",
      contactA,
    );
    const byKeyA = Object.fromEntries(valuesA.map((v) => [v.key, v.value]));
    expect(byKeyA.account_tier).toBe("gold");

    // Touch the repository symbol so the import is load-bearing (compose-in-tx surface is covered by core).
    expect(typeof customFieldRepository.mergeValues).toBe("function");
  });
});
