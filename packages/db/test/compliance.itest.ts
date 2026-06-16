// compliance.itest.ts — the M5 Definition-of-Done proof on a real Postgres 16 (10/14 §3.6): Testcontainers
// by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Run in its OWN process:
// `bun test ./packages/db/test/compliance.itest.ts`.
//
// Proves (08 §2/§3/§4, H5/H6): (1) the DSAR delete fan-out tombstones EVERY per-workspace copy across
// tenants, purges dependents, adds global suppression, audits per copy, and completes ONLY after the
// verification scan passes; (2) the fan-out is idempotent; (3) tombstones never surface (masked list +
// reveal); (4) a re-imported copy of the erased subject can never be revealed (global suppression);
// (5) the access report enumerates copies across workspaces with footprints; (6) consent withdrawal
// auto-adds global suppression that blocks reveals; (7) the app role sees ZERO dsar_requests rows
// (privileged-only table) while the admin path reads them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

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

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string | null> {
  const [r] = await admin`
    SELECT id FROM contacts
    WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain} AND deleted_at IS NULL`;
  return r ? (r as { id: string }).id : null;
}

beforeAll(async () => {
  dbHandle = await startItestDb("compliance");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedWorkspace("globex"));

  core = await import("../../core/src/index.ts");
  // The same humans live in BOTH workspaces (separate copies — the fan-out must find them all).
  for (const [tenantId, workspaceId] of [
    [tenantA, wsA],
    [tenantB, wsB],
  ] as const) {
    await core.runImport({
      scope: { tenantId, workspaceId },
      sourceName: "manual",
      mapping: MAPPING,
      rows: ROWS,
    });
  }
  // Reveals + consent in A so the fan-out has dependents to purge.
  const janeA = (await contactIdByDomain(wsA, "acme.com")) as string;
  await core.revealContact({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    contactId: janeA,
    revealType: "email",
  });
  await core.recordConsent(
    { tenantId: tenantA, workspaceId: wsA },
    {
      contactId: janeA,
      jurisdiction: "US",
      lawfulBasis: "legitimate_interest",
      recordedByUserId: ownerA,
    },
  );
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M5 compliance hardening DoD", () => {
  test("the DSAR delete fan-out erases every copy, purges dependents, suppresses globally, and verifies", async () => {
    const janeA = (await contactIdByDomain(wsA, "acme.com")) as string;
    const janeB = (await contactIdByDomain(wsB, "acme.com")) as string;

    const requestId = await core.createDsarRequest("delete", "jane@acme.com");
    const result = await core.deleteFanout(requestId, "jane@acme.com");

    expect(result.copiesErased).toBe(2);
    expect(result.completed).toBe(true);
    expect(result.verification).toEqual({ liveCopies: 0, piiOnTombstones: 0, dependents: 0 });

    for (const id of [janeA, janeB]) {
      const [c] = await admin`
        SELECT deleted_at, email_enc, email_blind_index, first_name, last_name
        FROM contacts WHERE id = ${id}`;
      const row = c as Record<string, unknown>;
      expect(row.deleted_at).not.toBeNull();
      expect(row.email_enc).toBeNull();
      expect(row.email_blind_index).toBeNull();
      expect(row.first_name).toBeNull();
    }
    const [deps] = await admin`
      SELECT (SELECT count(*) FROM source_imports WHERE contact_id IN (${janeA}, ${janeB}))::int
           + (SELECT count(*) FROM contact_reveals WHERE contact_id IN (${janeA}, ${janeB}))::int
           + (SELECT count(*) FROM consent_records WHERE contact_id IN (${janeA}, ${janeB}))::int AS n`;
    expect((deps as { n: number }).n).toBe(0);

    const [sup] = await admin`
      SELECT count(*)::int AS n FROM suppression_list WHERE scope = 'global' AND reason = ${`dsar:${requestId}`}`;
    expect((sup as { n: number }).n).toBe(1);
    const [aud] = await admin`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'dsar.delete' AND metadata->>'requestId' = ${requestId}`;
    expect((aud as { n: number }).n).toBe(2); // one proof row PER copy

    const [req] =
      await admin`SELECT status, completed_at FROM dsar_requests WHERE id = ${requestId}`;
    expect((req as { status: string }).status).toBe("completed");
    expect((req as { completed_at: Date | null }).completed_at).not.toBeNull();
  });

  test("re-running the fan-out is an idempotent no-op", async () => {
    const requestId = await core.createDsarRequest("delete", "jane@acme.com");
    const again = await core.deleteFanout(requestId, "jane@acme.com");
    expect(again.copiesErased).toBe(0);
    expect(again.completed).toBe(true);
  });

  test("tombstones never surface: masked list excludes them and reveal returns not_found", async () => {
    const { contactRepository } = await import("@leadwolf/db");
    const list = await contactRepository.listByWorkspace(
      { tenantId: tenantA, workspaceId: wsA },
      100,
    );
    expect(list.some((c) => c.emailDomain === "acme.com")).toBe(false);

    const [tomb] = await admin`
      SELECT id FROM contacts WHERE workspace_id = ${wsA} AND deleted_at IS NOT NULL LIMIT 1`;
    await expect(
      core.revealContact({
        scope: { tenantId: tenantA, workspaceId: wsA },
        userId: ownerA,
        contactId: (tomb as { id: string }).id,
        revealType: "email",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("a re-imported copy of the erased subject can never be revealed (global suppression holds)", async () => {
    await core.runImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      sourceName: "manual",
      mapping: MAPPING,
      rows: [ROWS[0]!], // jane comes back from a fresh source
    });
    const reimported = (await contactIdByDomain(wsA, "acme.com")) as string;
    await expect(
      core.revealContact({
        scope: { tenantId: tenantA, workspaceId: wsA },
        userId: ownerA,
        contactId: reimported,
        revealType: "email",
      }),
    ).rejects.toMatchObject({ code: "suppressed" });
    const [aud] = await admin`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'reveal.blocked' AND entity_id = ${reimported}`;
    expect((aud as { n: number }).n).toBe(1);
  });

  test("the access report enumerates copies across workspaces with their footprints", async () => {
    const requestId = await core.createDsarRequest("access", "mark@globex.com");
    const report = await core.assembleAccessReport(requestId, "mark@globex.com");
    expect(report.copies).toHaveLength(2);
    expect(new Set(report.copies.map((c) => c.workspaceId))).toEqual(new Set([wsA, wsB]));
    for (const copy of report.copies) expect(copy.sourceImports).toBeGreaterThan(0);
    const [aud] = await admin`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'dsar.access' AND metadata->>'requestId' = ${requestId}`;
    expect((aud as { n: number }).n).toBe(2);
  });

  test("consent withdrawal auto-adds global suppression that blocks reveals (08 §2)", async () => {
    const lenaB = (await contactIdByDomain(wsB, "initech.com")) as string;
    const result = await core.withdrawConsent(
      { tenantId: tenantB, workspaceId: wsB },
      lenaB,
      ownerB,
    );
    expect(result.globallySuppressed).toBe(true);
    await expect(
      core.revealContact({
        scope: { tenantId: tenantB, workspaceId: wsB },
        userId: ownerB,
        contactId: lenaB,
        revealType: "email",
      }),
    ).rejects.toMatchObject({ code: "suppressed" });
  });

  test("dsar_requests is privileged-only: the app role sees zero rows; the admin path reads them", async () => {
    const app = postgres(dbHandle.appUrl, { max: 1, onnotice: () => {} });
    try {
      const [r] = await app`SELECT count(*)::int AS n FROM dsar_requests`;
      expect((r as { n: number }).n).toBe(0); // FORCE RLS + no policy → deny-all for leadwolf_app
    } finally {
      await app.end();
    }
    const [total] = await admin`SELECT count(*)::int AS n FROM dsar_requests`;
    expect((total as { n: number }).n).toBeGreaterThan(0);
  });
});
