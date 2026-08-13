// enrichWaterfallV2.itest.ts — waterfall v2 (0111) end-to-end on a real Postgres 16: the tx-split
// enrichContact path behind the dual gate (WATERFALL_V2_ENABLED env + enrichment_waterfall_v2 tenant
// flag), with stub providers and a static verifier injected through EnrichDeps. [S-04][S-08][A-01]
//
// Proves: (1) a full v2 run — per-field winners from DIFFERENT providers, one provider_calls row per
// attempt with filled_fields/latency, email_status persisted from the verify verdict, one source_imports
// row per WINNING provider; (2) the per-field cache short-circuits an identical second run with ZERO new
// ledger rows; (3) a user-pinned scalar survives a provider fill; (4) a per-run providerOrder override
// is honored (the skipped provider is never called); (5) an all-miss run lands as `unfilled` with every
// paid attempt ledgered. CI is the runner (Postgres only lives there); `bun test` skips *.itest.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;

let tenantA = "";
let wsA = "";

/** Stub provider factory (the fieldWaterfall.test.ts shape) — names MUST be real sourceName members so
 *  source_imports rows land (apollo/pdl/coresignal/zoominfo/clearbit). */
function stub(
  name: string,
  answer: Partial<Record<string, string>>,
  cost = 10_000,
): { provider: import("../../core/src/index.ts").EnrichmentProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name,
      capabilities: ["contact.email", "contact.phone", "contact.profile"],
      trust: 0.8,
      estimateCostMicros: () => cost,
      enrich(req) {
        calls += 1;
        const fields = req.fields
          .filter((f) => answer[f])
          .map((f) => ({ field: f, value: answer[f] as string }));
        return Promise.resolve(
          fields.length > 0
            ? { fields, rawPayload: { stub: name }, costMicros: cost, status: "hit" as const }
            : { fields: [], rawPayload: { stub: name }, costMicros: cost, status: "miss" as const },
        );
      },
    },
  };
}

/** A contact whose email_domain makes the request hash unique per test. */
async function seedContact(domain: string, extra = ""): Promise<string> {
  const rows = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name, email_domain)
    VALUES (${tenantA}, ${wsA}, 'Case', ${domain + extra}, ${domain})
    RETURNING id`;
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("enrichWaterfallV2");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  // The v2 env half of the dual gate — MUST be set before the first @leadwolf/config import below.
  process.env.WATERFALL_V2_ENABLED = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, 'acme', 'acme', true, NULL) RETURNING id`;
  tenantA = t!.id;
  wsA = w!.id;

  // The per-tenant half of the dual gate (tenant override wins over global).
  await admin`
    INSERT INTO feature_flags (key, description, global_enabled, "default")
    VALUES ('enrichment_waterfall_v2', 'itest', false, false)
    ON CONFLICT (key) DO NOTHING`;
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES ('enrichment_waterfall_v2', ${tenantA}, true)`;

  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("waterfall v2 end-to-end (0111)", () => {
  test("per-field winners from different providers: ledger rows, email_status, source_imports", async () => {
    const contactId = await seedContact("case1.com");
    const apollo = stub("apollo", {}); // paid miss
    const pdl = stub("pdl", { email: "jane@case1.com" }, 40_000);
    const coresignal = stub("coresignal", { phone: "+14155550100" }, 35_000);

    const result = await core.enrichContact(
      {
        scope: { tenantId: tenantA, workspaceId: wsA },
        contactId,
        fields: ["email", "phone"],
        providers: [apollo.provider, pdl.provider, coresignal.provider],
        providerOrder: ["apollo", "pdl", "coresignal"],
      },
      { emailVerifier: core.staticVerifier({ "jane@case1.com": "valid" }) },
    );

    expect(result.status).toBe("enriched");
    expect(result.filled.sort()).toEqual(["email", "phone"]);
    expect(result.filledBy).toEqual({ email: "pdl", phone: "coresignal" });
    expect(result.emailStatus).toBe("valid");
    // apollo miss (10k) + pdl hit (40k) + coresignal hit (35k); the verify attempt costs 0 by default.
    expect(result.costMicros).toBe(85_000);
    expect(apollo.calls()).toBe(1);
    expect(pdl.calls()).toBe(1);
    expect(coresignal.calls()).toBe(1);

    // Ledger: one row per attempt (miss AND hits) + the verify row — the 0111 fix in action.
    const calls = await admin`
      SELECT provider_name, status, cost_micros::int AS cost, filled_fields
      FROM provider_calls WHERE workspace_id = ${wsA} ORDER BY provider_name`;
    const byName = Object.fromEntries(
      calls.map((c) => [c.provider_name as string, c as Record<string, unknown>]),
    );
    expect(byName.apollo?.status).toBe("miss");
    expect(byName.apollo?.filled_fields).toEqual([]);
    expect(byName.pdl?.status).toBe("hit");
    expect(byName.pdl?.filled_fields).toEqual(["email"]);
    expect(byName.coresignal?.filled_fields).toEqual(["phone"]);
    expect(byName["verify:email:pdl"]?.status).toBe("hit");

    // The contact: encrypted email landed with the verify verdict + the freshness stamp.
    const [c] = await admin`
      SELECT email_domain, email_status, last_verified_at, email_enc, phone_enc
      FROM contacts WHERE id = ${contactId}`;
    expect((c as { email_status: string }).email_status).toBe("valid");
    expect((c as { email_domain: string }).email_domain).toBe("case1.com");
    expect((c as { last_verified_at: Date | null }).last_verified_at).not.toBeNull();
    expect((c as { email_enc: unknown }).email_enc).not.toBeNull();
    expect((c as { phone_enc: unknown }).phone_enc).not.toBeNull();

    // One source_imports row per WINNING provider (apollo missed → no row).
    const imports = await admin`
      SELECT source_name FROM source_imports WHERE contact_id = ${contactId} ORDER BY source_name`;
    expect(imports.map((r) => r.source_name)).toEqual(["coresignal", "pdl"]);
  });

  test("an identical second run is a per-field cache hit: zero new ledger rows, zero provider calls", async () => {
    const contactId = await seedContact("case1.com", "-again");
    // Same email_domain as case1 → same subject → SAME request hash → the cache already covers email+phone.
    const apollo = stub("apollo", { email: "other@case1.com" });

    const before =
      await admin`SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA}`;
    const result = await core.enrichContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      contactId,
      fields: ["email", "phone"],
      providers: [apollo.provider],
    });
    const after =
      await admin`SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA}`;

    expect(result.status).toBe("cache_hit");
    expect(result.costMicros).toBe(0);
    expect(apollo.calls()).toBe(0);
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n);
  });

  test("a user-pinned scalar survives a provider fill (the pin outranks the provider)", async () => {
    const contactId = await seedContact("case3.com");
    await admin`
      UPDATE contacts
      SET job_title = 'Founder',
          field_provenance = '{"jobTitle": {"src": "user_edit", "pin": true}}'::jsonb
      WHERE id = ${contactId}`;

    const pdl = stub("pdl", { jobTitle: "Intern", email: "j@case3.com" }, 40_000);
    const result = await core.enrichContact(
      {
        scope: { tenantId: tenantA, workspaceId: wsA },
        contactId,
        fields: ["email", "jobTitle"],
        providers: [pdl.provider],
      },
      { emailVerifier: core.staticVerifier({ "j@case3.com": "valid" }) },
    );
    expect(result.status).toBe("enriched");

    const [c] = await admin`SELECT job_title, email_status FROM contacts WHERE id = ${contactId}`;
    expect((c as { job_title: string }).job_title).toBe("Founder"); // pinned — Intern never landed
    expect((c as { email_status: string }).email_status).toBe("valid"); // email is not pin-gated
  });

  test("a per-run providerOrder override is honored: the overridden-away provider is never called", async () => {
    const contactId = await seedContact("case4.com");
    const apollo = stub("apollo", { email: "a@case4.com" }, 5_000); // cheapest → default order would pick it first
    const pdl = stub("pdl", { email: "p@case4.com" }, 40_000);

    const result = await core.enrichContact(
      {
        scope: { tenantId: tenantA, workspaceId: wsA },
        contactId,
        fields: ["email"],
        providers: [apollo.provider, pdl.provider],
        providerOrder: ["pdl"], // explicit prefix: pdl first; it hits, so apollo is never reached
      },
      { emailVerifier: core.staticVerifier({ "p@case4.com": "valid" }) },
    );
    expect(result.filledBy).toEqual({ email: "pdl" });
    expect(pdl.calls()).toBe(1);
    expect(apollo.calls()).toBe(0);
  });

  test("an all-miss run lands as `unfilled` with every paid attempt ledgered", async () => {
    const contactId = await seedContact("case5.com");
    const apollo = stub("apollo", {});
    const pdl = stub("pdl", {}, 40_000);

    const before =
      await admin`SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA}`;
    const result = await core.enrichContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      contactId,
      fields: ["email"],
      providers: [apollo.provider, pdl.provider],
    });
    const after =
      await admin`SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA}`;

    expect(result.status).toBe("unfilled");
    expect(result.costMicros).toBe(50_000); // both paid misses counted — the pre-0111 ledger lost one
    // BOTH miss rows persisted under the same hash (the ledger fix — pre-0111 the second was dropped).
    expect((after[0] as { n: number }).n - (before[0] as { n: number }).n).toBe(2);
  });
});
