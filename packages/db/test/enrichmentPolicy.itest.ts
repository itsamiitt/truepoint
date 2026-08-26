// enrichmentPolicy.itest.ts — the per-workspace auto-enrich policy (G-ENR-1; 29 §3, 06 §4.1) Definition-of-
// Done proof on a real Postgres 16: Testcontainers by default, or an external server via ITEST_DATABASE_URL
// (see itestDb.ts). Requires generated src/migrations (`bun run --filter @leadwolf/db generate`). Named
// *.itest.ts so default `bun test` skips it; run explicitly: `bun test packages/db/test/enrichmentPolicy.itest.ts`.
//
// Proves: (1) upsert then get round-trips the policy within a workspace; (2) a second upsert REPLACES the
// row (one policy per workspace, never two); (3) PER-WORKSPACE RLS isolation — under the non-BYPASSRLS
// leadwolf_app role, workspace A reading with B's scope sees NOTHING, and an INSERT that lies about the
// workspace_id is rejected by the WITH CHECK; (4) monthlySpentMicros sums only the current month's
// provider_calls for the scoped workspace (the input to the monthly budget cap the core guard enforces);
// (5) the core decideAutoEnrich guard stops at the budget cap given that spend.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");
type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let dbApi: Db;
let core: Core;
let admin: ReturnType<typeof postgres>;

let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, NULL) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

/** Insert a provider_calls cost row (the ledger the monthly budget reads) at a given time. request_hash is
 *  bytea (unique per (workspace, hash)) — a fresh 32 random bytes keeps every seed row distinct. */
async function seedProviderCall(
  tenantId: string,
  workspaceId: string,
  costMicros: number,
  calledAt: Date,
): Promise<void> {
  const requestHash = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  await admin`
    INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros, called_at)
    VALUES (${tenantId}, ${workspaceId}, 'apollo', ${requestHash}, 'hit', ${costMicros}, ${calledAt})`;
}

beforeAll(async () => {
  dbHandle = await startItestDb("enrichmentPolicy");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  dbApi = await import("../src/index.ts");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("G-ENR-1 auto-enrich policy DoD", () => {
  test("upsert then get round-trips the policy within a workspace", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const saved = await dbApi.enrichmentPolicyRepository.upsert(scope, {
      tenantId: tenantA,
      workspaceId: wsA,
      enabled: true,
      triggers: ["on_import", "on_reveal"],
      fieldAllowlist: ["email", "phone"],
      monthlyBudgetMicros: 5_000_000,
    });
    expect(saved.enabled).toBe(true);
    expect(saved.triggers).toEqual(["on_import", "on_reveal"]);

    const got = await dbApi.enrichmentPolicyRepository.get(scope);
    expect(got).not.toBeNull();
    expect(got?.enabled).toBe(true);
    expect(got?.fieldAllowlist).toEqual(["email", "phone"]);
    expect(got?.monthlyBudgetMicros).toBe(5_000_000);
  });

  test("get returns null for an unconfigured workspace (caller applies off-by-default)", async () => {
    const got = await dbApi.enrichmentPolicyRepository.get({ tenantId: tenantB, workspaceId: wsB });
    expect(got).toBeNull();
  });

  test("a second upsert REPLACES the row — one policy per workspace, never two", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    await dbApi.enrichmentPolicyRepository.upsert(scope, {
      tenantId: tenantA,
      workspaceId: wsA,
      enabled: false,
      triggers: ["on_stale"],
      fieldAllowlist: ["jobTitle"],
      monthlyBudgetMicros: 1_000_000,
    });
    const got = await dbApi.enrichmentPolicyRepository.get(scope);
    expect(got?.enabled).toBe(false);
    expect(got?.triggers).toEqual(["on_stale"]);

    const [n] = await admin`
      SELECT count(*)::int AS n FROM enrichment_policy WHERE workspace_id = ${wsA}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("PER-WORKSPACE RLS isolation: A's policy is invisible under B's scope, foreign INSERT rejected", async () => {
    // A has a policy (from the round-trip test); B does not. Reading with B's scope must never see A's row.
    const asB = await dbApi.enrichmentPolicyRepository.get({ tenantId: tenantB, workspaceId: wsB });
    expect(asB).toBeNull();

    // Direct proof under the NON-BYPASSRLS leadwolf_app role: set B's GUC, then try to read/insert A's row.
    const app = postgres(dbHandle.appUrl, { max: 1, onnotice: () => {} });
    try {
      const rows = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        return tx`SELECT id FROM enrichment_policy WHERE workspace_id = ${wsA}`;
      });
      expect(rows.length).toBe(0); // RLS hides A's row from a B-scoped transaction

      // An INSERT that lies about the workspace_id (claims A while scoped to B) is rejected by WITH CHECK.
      //
      // Captured with `.then` rather than `expect(...).rejects` (CLAUDE.md; the note at
      // activitiesPartitioned.itest.ts:233). Handing a rejecting DB call to `.rejects` can leave the promise
      // unsettled on the single pooled connection, and the symptom is a HANG rather than a failure — this
      // case burned its full 240s timeout before the rewrite.
      const insertError = await app
        .begin(async (tx) => {
          await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
          await tx`
          INSERT INTO enrichment_policy (tenant_id, workspace_id, enabled)
          VALUES (${tenantA}, ${wsA}, true)`;
        })
        .then(
          () => "",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
      expect(insertError).not.toBe("");
    } finally {
      await app.end();
    }
  });

  test("provider_prefs round-trips: priority + verification survive applyPartial and re-read (0111)", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const written = await dbApi.enrichmentPolicyRepository.applyPartial(
      scope,
      { tenantId: tenantA, workspaceId: wsA },
      {
        providerPriority: {
          version: 1,
          email: ["pdl", "apollo"],
          phone: ["apollo"],
          disabled: ["clearbit"],
        },
        verification: {
          verifyEmailBeforeAccept: true,
          acceptCatchAll: "continue",
          verifyPhone: false,
        },
      },
      { userId: null },
    );
    expect(written.providerPriority.email).toEqual(["pdl", "apollo"]);
    expect(written.providerPriority.disabled).toEqual(["clearbit"]);
    expect(written.verification.acceptCatchAll).toBe("continue");

    const got = await dbApi.enrichmentPolicyRepository.get(scope);
    expect(got?.providerPriority.email).toEqual(["pdl", "apollo"]);
    expect(got?.providerPriority.phone).toEqual(["apollo"]);
    expect(got?.verification.acceptCatchAll).toBe("continue");
    // The patch touched only prefs — the pre-existing policy fields survive the merge.
    expect(got?.triggers).toEqual(["on_stale"]);

    // The audited change: applyPartial with an actor writes the audit row in the SAME tx.
    const audits = await admin`
      SELECT action, entity_type, metadata FROM audit_log
      WHERE workspace_id = ${wsA} AND action = 'enrichment.policy_updated'`;
    expect(audits.length).toBe(1);
    expect((audits[0] as { entity_type: string }).entity_type).toBe("enrichment_policy");
  });

  test("an unparseable/legacy provider_prefs jsonb degrades to engine defaults, never leaks", async () => {
    await admin`
      UPDATE enrichment_policy SET provider_prefs = '{"providerPriority":{"version":99,"bogus":true}}'::jsonb
      WHERE workspace_id = ${wsA}`;
    const got = await dbApi.enrichmentPolicyRepository.get({ tenantId: tenantA, workspaceId: wsA });
    expect(got?.providerPriority).toEqual({ version: 1, email: [], phone: [], disabled: [] });
    expect(got?.verification.verifyEmailBeforeAccept).toBe(true);
  });

  test("monthlySpentMicros sums only THIS month's provider_calls for the scoped workspace", async () => {
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0));

    await seedProviderCall(tenantA, wsA, 300_000, thisMonth);
    await seedProviderCall(tenantA, wsA, 200_000, thisMonth);
    await seedProviderCall(tenantA, wsA, 999_999, lastMonth); // prior month — excluded
    await seedProviderCall(tenantB, wsB, 777_777, thisMonth); // other workspace — excluded

    const spentA = await dbApi.enrichmentPolicyRepository.monthlySpentMicros({
      tenantId: tenantA,
      workspaceId: wsA,
    });
    expect(spentA).toBe(500_000); // only this-month, this-workspace rows
  });

  test("the core guard stops at the monthly budget cap given the measured spend", () => {
    // 500k spent this month (above); a 500k cap leaves zero headroom → budget_exhausted.
    const decision = core.decideAutoEnrich(
      {
        enabled: true,
        triggers: ["on_import"],
        fieldAllowlist: ["email"],
        monthlyBudgetMicros: 500_000,
        providerPriority: { version: 1, email: [], phone: [], disabled: [] },
        verification: { verifyEmailBeforeAccept: true, acceptCatchAll: "flag", verifyPhone: false },
      },
      { trigger: "on_import", requestedFields: ["email"], monthlySpentMicros: 500_000 },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("budget_exhausted");
  });
});
