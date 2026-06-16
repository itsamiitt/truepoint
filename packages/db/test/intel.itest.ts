// intel.itest.ts — the M4 Definition-of-Done proof on a real Postgres 16 (10/14 §3.5): Testcontainers by
// default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Run in its OWN process (the db
// client is a module singleton): `bun test ./packages/db/test/intel.itest.ts`.
//
// Proves: (1) enriching a thin contact lands fields per-workspace + a source_imports provenance row + a
// provider_calls row with recorded cost; (2) a repeat enrich is a cache hit (no second provider call, no
// cost); (3) the daily budget breaker blocks paid calls; (4) verify-on-reveal sets email_status AND the
// charge follows the verified result (ADR-0013: valid→cost, invalid→0 with the claim row recording the
// outcome, risky→charged by default); (5) re-revealing stays charged-exactly-once; (6) a re-score APPENDS
// a scores row and the trigger syncs contacts.priority_score (intent signals raise the composite).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Provider = import("../../core/src/index.ts").EnrichmentProvider;

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsA = "";
let ownerA = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
const ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "mark@globex.com",
    "First Name": "Mark",
    "Last Name": "Roe",
    Company: "Globex",
    Domain: "globex.com",
  },
  {
    Email: "lena@initech.com",
    "First Name": "Lena",
    "Last Name": "Lee",
    Company: "Initech",
    Domain: "initech.com",
  },
];

let providerCallCount = 0;
/** Fixture provider implementing the port — named "apollo" so provenance passes the sourceName enum. */
function fixtureProvider(): Provider {
  return {
    name: "apollo",
    trust: 0.8,
    capabilities: ["contact.profile"],
    estimateCostMicros: () => 30_000,
    enrich: () => {
      providerCallCount += 1;
      return Promise.resolve({
        fields: [{ field: "jobTitle", value: "VP Engineering" }],
        rawPayload: { person: { title: "VP Engineering" } },
        costMicros: 30_000,
        status: "hit",
      });
    },
  };
}

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("intel");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] =
    await admin`INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme','acme',10) RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M4 enrichment, verification & scoring DoD", () => {
  test("enriching a thin contact lands fields + provenance + recorded cost", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const result = await core.enrichContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      contactId,
      fields: ["jobTitle"],
      providers: [fixtureProvider()],
      requestedByUserId: ownerA,
    });
    expect(result.status).toBe("enriched");
    expect(result.provider).toBe("apollo");
    expect(result.filled).toEqual(["jobTitle"]);
    expect(result.costMicros).toBe(30_000);
    expect(providerCallCount).toBe(1);

    const [c] = await admin`SELECT job_title FROM contacts WHERE id = ${contactId}`;
    expect((c as { job_title: string }).job_title).toBe("VP Engineering");
    const [p] = await admin`
      SELECT count(*)::int AS n FROM provider_calls
      WHERE workspace_id = ${wsA} AND provider_name = 'apollo' AND cost_micros = 30000`;
    expect((p as { n: number }).n).toBe(1);
    const [s] = await admin`
      SELECT count(*)::int AS n FROM source_imports
      WHERE workspace_id = ${wsA} AND contact_id = ${contactId} AND source_name = 'apollo'`;
    expect((s as { n: number }).n).toBe(1);
  });

  test("a repeat enrich is a cache hit — no second provider call, no cost", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const result = await core.enrichContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      contactId,
      fields: ["jobTitle"],
      providers: [fixtureProvider()],
    });
    expect(result.status).toBe("cache_hit");
    expect(result.costMicros).toBe(0);
    expect(providerCallCount).toBe(1); // unchanged
  });

  test("the daily budget breaker blocks paid calls once spend reaches the cap", async () => {
    // Pre-record spend equal to the default budget on a different request hash.
    await admin`
      INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros)
      VALUES (${tenantA}, ${wsA}, 'apollo', ${Buffer.from("budget-filler-hash-000000000000")}, 'hit', 50000000)`;
    const contactId = await contactIdByDomain(wsA, "globex.com");
    await expect(
      core.enrichContact({
        scope: { tenantId: tenantA, workspaceId: wsA },
        contactId,
        fields: ["jobTitle"],
        providers: [fixtureProvider()],
      }),
    ).rejects.toMatchObject({ code: "enrichment_budget_exhausted" });
    await admin`DELETE FROM provider_calls WHERE cost_micros = 50000000`;
  });

  test("verify-on-reveal sets email_status and the charge follows the verified result (ADR-0013)", async () => {
    const verifier = core.staticVerifier({
      "jane@acme.com": "valid",
      "mark@globex.com": "invalid",
      "lena@initech.com": "risky",
    });
    const scope = { tenantId: tenantA, workspaceId: wsA };

    const valid = await core.revealContact({
      scope,
      userId: ownerA,
      revealType: "email",
      verifier,
      contactId: await contactIdByDomain(wsA, "acme.com"),
    });
    expect(valid.creditsCharged).toBe(1);
    expect(valid.emailStatus).toBe("valid");

    const invalidId = await contactIdByDomain(wsA, "globex.com");
    const invalid = await core.revealContact({
      scope,
      userId: ownerA,
      revealType: "email",
      verifier,
      contactId: invalidId,
    });
    expect(invalid.creditsCharged).toBe(0); // unusable result is never charged
    expect(invalid.emailStatus).toBe("invalid");
    expect(invalid.email).toBe("mark@globex.com"); // the outcome is still returned (07 §3)
    const [row] = await admin`
      SELECT credits_consumed FROM contact_reveals WHERE workspace_id = ${wsA} AND contact_id = ${invalidId}`;
    expect((row as { credits_consumed: number }).credits_consumed).toBe(0);
    const [c] = await admin`SELECT email_status FROM contacts WHERE id = ${invalidId}`;
    expect((c as { email_status: string }).email_status).toBe("invalid");

    const risky = await core.revealContact({
      scope,
      userId: ownerA,
      revealType: "email",
      verifier,
      contactId: await contactIdByDomain(wsA, "initech.com"),
    });
    expect(risky.creditsCharged).toBe(1); // charged-but-flagged default
    expect(risky.emailStatus).toBe("risky");

    const [t] = await admin`SELECT reveal_credit_balance AS b FROM tenants WHERE id = ${tenantA}`;
    expect((t as { b: number }).b).toBe(8); // 10 − valid(1) − invalid(0) − risky(1)
  });

  test("a re-reveal of the verified copy stays free (charged exactly once)", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const again = await core.revealContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      userId: ownerA,
      revealType: "email",
      contactId,
    });
    expect(again.alreadyOwned).toBe(true);
    expect(again.creditsCharged).toBe(0);
  });

  test("a re-score appends a scores row and the trigger syncs priority_score; signals raise it", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const scope = { tenantId: tenantA, workspaceId: wsA };

    const first = await core.computeScore({ scope, contactId });
    const [c1] = await admin`SELECT priority_score FROM contacts WHERE id = ${contactId}`;
    expect((c1 as { priority_score: number }).priority_score).toBe(first.compositeScore);

    await admin`
      INSERT INTO intent_signals (tenant_id, workspace_id, contact_id, signal_type, signal_source, weight)
      VALUES (${tenantA}, ${wsA}, ${contactId}, 'funding_round', 'fixture', 8)`;
    const second = await core.computeScore({ scope, contactId });
    expect(second.intentScore).toBeGreaterThan(first.intentScore);
    expect(second.compositeScore).toBeGreaterThan(first.compositeScore);

    const [n] = await admin`SELECT count(*)::int AS n FROM scores WHERE contact_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(2); // append-per-rescore, history preserved
    const [c2] = await admin`SELECT priority_score FROM contacts WHERE id = ${contactId}`;
    expect((c2 as { priority_score: number }).priority_score).toBe(second.compositeScore);
  });
});
