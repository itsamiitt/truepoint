// home.itest.ts — the M-Home Definition-of-Done proof on a real Postgres 16 (10/14 §3.5): Testcontainers by
// default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Requires generated src/migrations
// (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test` skips it; run in its OWN
// process (the db client is a module singleton): `bun test packages/db/test/home.itest.ts`.
//
// Proves the Home dashboard DTO (07 §2) is built ENTIRELY from the scoped workspace and never leaks across
// the tenant boundary or leaks PII. Two tenants/workspaces (A=acme, B=globex) are driven through the real
// pipelines (import → reveal → enrich → sequence/enroll → activity → audit), then buildHomeSummary(A) must:
// (1) return ONLY A's rows — none of B's reveals/imports/enrichment/sequences/activity ever appear; (2) the
// burn buckets sum to A's reveal spend; (3) creditBalance equals A's tenant counter; (4) hotLeads come back
// priority-desc, capped at 5, carrying NO PII fields (no email/phone, encrypted or otherwise); (5) the
// activity feed includes A's workspace rows PLUS the tenant-level (workspace_id IS NULL) rows, but never B's
// (neither B's workspace rows nor B's tenant-level rows); (6) one CSV import collapses to one source_file batch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("@leadwolf/core");
type Provider = import("@leadwolf/core").EnrichmentProvider;

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";
let ownerB = "";

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

/** Fixture provider implementing the port — named "apollo" so provenance passes the sourceName enum. */
function fixtureProvider(): Provider {
  return {
    name: "apollo",
    trust: 0.8,
    capabilities: ["contact.profile"],
    estimateCostMicros: () => 30_000,
    enrich: () =>
      Promise.resolve({
        fields: [{ field: "jobTitle", value: "VP Engineering" }],
        rawPayload: { person: { title: "VP Engineering" } },
        costMicros: 30_000,
        status: "hit",
      }),
  };
}

// Global-identity seeding (ADR-0019): users is global; org membership lives in tenant_members.
async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

async function setBalance(tenantId: string, balance: number): Promise<void> {
  await admin`UPDATE tenants SET reveal_credit_balance = ${balance} WHERE id = ${tenantId}`;
}

async function balanceOf(tenantId: string): Promise<number> {
  const [r] = await admin`SELECT reveal_credit_balance AS b FROM tenants WHERE id = ${tenantId}`;
  return (r as { b: number }).b;
}

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

/** Drive the full set of Home-feeding pipelines for one workspace (import → reveal → enrich → sequence/
 * enroll → activity → tenant-level audit). One call seeds everything a Home summary reads. */
async function seedWorkspaceActivity(args: {
  tenantId: string;
  workspaceId: string;
  ownerId: string;
  sourceFile: string;
}): Promise<void> {
  const scope = { tenantId: args.tenantId, workspaceId: args.workspaceId };

  // (6) one CSV → one logical import batch (every contact row shares the same source_file).
  await core.runImport({
    scope,
    importedByUserId: args.ownerId,
    sourceName: "manual",
    sourceFile: args.sourceFile,
    mapping: MAPPING,
    rows: ROWS,
  });

  // Two paid reveals → two contact_reveals rows + two `reveal` audit rows + 2 credits of burn.
  await core.revealContact({
    scope,
    userId: args.ownerId,
    contactId: await contactIdByDomain(args.workspaceId, "acme.com"),
    revealType: "email",
  });
  await core.revealContact({
    scope,
    userId: args.ownerId,
    contactId: await contactIdByDomain(args.workspaceId, "globex.com"),
    revealType: "email",
  });

  // One enrichment call → a provider_calls row for the enrichmentActivity panel.
  await core.enrichContact({
    scope,
    contactId: await contactIdByDomain(args.workspaceId, "initech.com"),
    fields: ["jobTitle"],
    providers: [fixtureProvider()],
    requestedByUserId: args.ownerId,
  });

  // Score every contact so each gets a priority_score (the trigger syncs it) — this populates hotLeads and
  // lets the desc-ordering assertion bite. Distinct job titles give distinct ICP-fit scores → a real order.
  for (const domain of ["acme.com", "globex.com", "initech.com"]) {
    await core.computeScore({
      scope,
      contactId: await contactIdByDomain(args.workspaceId, domain),
    });
  }

  // One active sequence + step + enroll a revealed contact → sequenceSnapshot + `enroll` audit row.
  const seq = await core.createSequence({
    scope,
    userId: args.ownerId,
    name: `Sequence ${args.sourceFile}`,
    fromAddress: "sdr@acme.com",
    physicalAddress: "500 Howard St, San Francisco, CA 94105",
  });
  await core.addStep({
    scope,
    userId: args.ownerId,
    sequenceId: seq.id,
    subject: "Quick intro",
    body: "Hi — worth a chat?",
  });
  await core.enrollContact({
    scope,
    userId: args.ownerId,
    sequenceId: seq.id,
    contactId: await contactIdByDomain(args.workspaceId, "acme.com"),
  });

  // Two email_sent activities → the sequenceSnapshot.sent count is derived from this bucket.
  for (let i = 0; i < 2; i++) {
    await core.logActivity({
      scope,
      contactId: await contactIdByDomain(args.workspaceId, "acme.com"),
      actorUserId: args.ownerId,
      activityType: "email_sent",
      channel: "email",
    });
  }

  // A tenant-level audit row (workspace_id IS NULL) — the activity feed must surface THIS tenant's row but
  // never the OTHER tenant's. Inserted directly with the system actor (null) like the other itests seed.
  await admin`
    INSERT INTO audit_log (tenant_id, workspace_id, action, entity_type, entity_id)
    VALUES (${args.tenantId}, NULL, 'settings.update', 'tenant', ${args.tenantId})`;
}

beforeAll(async () => {
  dbHandle = await startItestDb("home");

  // Bind the app's config/db client to the test database BEFORE importing @leadwolf/core.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedWorkspace("globex"));

  // Fixed starting balances so the burn/balance arithmetic is exact (each workspace burns 2 credits).
  await setBalance(tenantA, 10);
  await setBalance(tenantB, 7);

  core = await import("@leadwolf/core");
  await seedWorkspaceActivity({
    tenantId: tenantA,
    workspaceId: wsA,
    ownerId: ownerA,
    sourceFile: "book-a.csv",
  });
  await seedWorkspaceActivity({
    tenantId: tenantB,
    workspaceId: wsB,
    ownerId: ownerB,
    sourceFile: "book-b.csv",
  });
}, 240_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M-Home dashboard summary DoD", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("creditBalance mirrors the tenant counter; burn buckets sum to this workspace's spend", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });

    // A started at 10 and burned exactly 2 (two paid email reveals).
    expect(await balanceOf(tenantA)).toBe(8);
    expect(summary.creditBalance).toBe(8);

    const burned = summary.burn.reduce((acc, b) => acc + b.credits, 0);
    expect(burned).toBe(2);
    // The sparkline sum equals the sum of THIS workspace's reveal charges.
    const [r] = await admin`
      SELECT coalesce(sum(credits_consumed), 0)::int AS spend
      FROM contact_reveals WHERE workspace_id = ${wsA}`;
    expect(burned).toBe((r as { spend: number }).spend);
  });

  test("recentReveals are this workspace's only — B's reveals never appear", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });

    expect(summary.recentReveals.length).toBe(2);
    const aRevealIds = await admin`SELECT id FROM contact_reveals WHERE workspace_id = ${wsA}`;
    const aSet = new Set(aRevealIds.map((x) => (x as { id: string }).id));
    for (const rr of summary.recentReveals) expect(aSet.has(rr.id)).toBe(true);

    // Not one of B's reveal ids leaked into A's summary.
    const bRevealIds = await admin`SELECT id FROM contact_reveals WHERE workspace_id = ${wsB}`;
    const bSet = new Set(bRevealIds.map((x) => (x as { id: string }).id));
    for (const rr of summary.recentReveals) expect(bSet.has(rr.id)).toBe(false);
  });

  test("recentImports collapse one CSV into one source_file batch — and only A's file", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });

    // The one CSV collapses into exactly ONE logical batch (grouped by source_file/source/minute): its 3
    // sub-second contact rows fold together. (Enrichment adds its own 'apollo'/null-file provenance batch,
    // which is correct — it is a separate, non-CSV source — so we assert on the CSV batch specifically.)
    const csvBatches = summary.recentImports.filter((i) => i.sourceFile === "book-a.csv");
    expect(csvBatches.length).toBe(1);
    expect(csvBatches[0]!.contactCount).toBe(3); // the CSV's 3 distinct contacts, this workspace only
    expect(csvBatches[0]!.sourceName).toBe("manual");

    // B's "book-b.csv" never appears in A's summary.
    expect(summary.recentImports.map((i) => i.sourceFile)).not.toContain("book-b.csv");
  });

  test("enrichmentActivity is this workspace's provider calls only", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });
    expect(summary.enrichmentActivity.length).toBe(1);
    expect(summary.enrichmentActivity[0]!.providerName).toBe("apollo");

    const [n] = await admin`
      SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA}`;
    expect(summary.enrichmentActivity.length).toBe((n as { n: number }).n);
  });

  test("sequenceSnapshot counts this workspace only; sent is derived from the email_sent bucket", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });
    expect(summary.sequenceSnapshot.activeSequences).toBe(1); // sequences default to status 'active'
    expect(summary.sequenceSnapshot.enrolled).toBe(1);
    expect(summary.sequenceSnapshot.sent).toBe(2); // two email_sent activities
  });

  test("hotLeads are priority-desc, capped at 5, and carry NO PII (facets only)", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });

    expect(summary.hotLeads.length).toBe(3); // A's 3 scored contacts surface (well under the cap of 5)
    expect(summary.hotLeads.length).toBeLessThanOrEqual(5);
    // Descending by priorityScore.
    for (let i = 1; i < summary.hotLeads.length; i++) {
      expect(summary.hotLeads[i - 1]!.priorityScore).toBeGreaterThanOrEqual(
        summary.hotLeads[i]!.priorityScore,
      );
    }
    // FACETS ONLY: no email/phone (plaintext or ciphertext) ever rides on a hot lead.
    const allowed = new Set([
      "id",
      "firstName",
      "lastName",
      "jobTitle",
      "emailDomain",
      "priorityScore",
      "outreachStatus",
      "isRevealed",
    ]);
    for (const lead of summary.hotLeads) {
      for (const key of Object.keys(lead)) expect(allowed.has(key)).toBe(true);
      const asRecord = lead as Record<string, unknown>;
      expect(asRecord.email).toBeUndefined();
      expect(asRecord.emailEnc).toBeUndefined();
      expect(asRecord.phone).toBeUndefined();
      expect(asRecord.phoneEnc).toBeUndefined();
      expect(asRecord.emailBlindIndex).toBeUndefined();
    }

    // Every hot lead belongs to THIS workspace (none of B's contacts surfaced).
    const aContactIds = await admin`SELECT id FROM contacts WHERE workspace_id = ${wsA}`;
    const aSet = new Set(aContactIds.map((x) => (x as { id: string }).id));
    for (const lead of summary.hotLeads) expect(aSet.has(lead.id)).toBe(true);
  });

  test("activityFeed includes A's workspace rows + A's tenant-level (NULL) rows, but never B's", async () => {
    const summary = await core.buildHomeSummary({ scope: scopeA() });

    expect(summary.activityFeed.length).toBeGreaterThan(0);
    expect(summary.activityFeed.length).toBeLessThanOrEqual(15);

    // The feed carries the minimized projection only — no metadata/ip/userAgent keys (never leak PII).
    const allowed = new Set([
      "id",
      "action",
      "entityType",
      "entityId",
      "actorUserId",
      "occurredAt",
    ]);
    for (const item of summary.activityFeed) {
      for (const key of Object.keys(item)) expect(allowed.has(key)).toBe(true);
    }

    // The tenant-level (workspace_id IS NULL) row for A IS present.
    expect(summary.activityFeed.some((i) => i.action === "settings.update")).toBe(true);

    // Build the set of audit ids that legitimately belong to A's feed = A's workspace rows ∪ A's NULL rows.
    const aFeedIds = await admin`
      SELECT id FROM audit_log
      WHERE tenant_id = ${tenantA} AND (workspace_id = ${wsA} OR workspace_id IS NULL)`;
    const aSet = new Set(aFeedIds.map((x) => (x as { id: string }).id));
    for (const item of summary.activityFeed) expect(aSet.has(item.id)).toBe(true);

    // Not a single one of B's audit rows (workspace OR tenant-level) leaked into A's feed.
    const bFeedIds = await admin`SELECT id FROM audit_log WHERE tenant_id = ${tenantB}`;
    const bSet = new Set(bFeedIds.map((x) => (x as { id: string }).id));
    for (const item of summary.activityFeed) expect(bSet.has(item.id)).toBe(false);
  });
});
