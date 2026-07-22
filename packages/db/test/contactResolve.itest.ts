// contactResolve.itest.ts — the workspace-isolation proof for the browser extension's LinkedIn resolver
// (chrome-extension/14 X01; apps/api GET /contacts/by-linkedin/:publicId). Testcontainers Postgres by
// default, or ITEST_DATABASE_URL (see itestDb.ts). Requires generated src/migrations. Named *.itest.ts so
// default `bun test` skips it; run explicitly: `bun test packages/db/test/contactResolve.itest.ts`.
//
// Proves: (1) the slug resolves to THIS workspace's masked contact; (2) the SAME slug in two workspaces
// resolves to each workspace's OWN row and never the other's (the per-workspace uniq index + RLS isolation
// this endpoint rides); (3) an unknown slug is null; (4) a soft-deleted contact never resolves. The resolver
// returns only the masked, non-PII projection — no email/phone plaintext.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let db: Db;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

async function contactIdOf(workspaceId: string): Promise<string> {
  const [r] = await admin`SELECT id FROM contacts WHERE workspace_id = ${workspaceId} LIMIT 1`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("contactresolve");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  const core = await import("../../core/src/index.ts");
  // Seed one contact per workspace through the real import pipeline (encrypted PII + blind index).
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: [
      { Email: "jane@acme.com", "First Name": "Jane", "Last Name": "Doe", Company: "Acme", Domain: "acme.com" },
    ],
  });
  await core.runImport({
    scope: { tenantId: tenantB, workspaceId: wsB },
    sourceName: "manual",
    mapping: MAPPING,
    rows: [
      { Email: "bob@globex.com", "First Name": "Bob", "Last Name": "Roe", Company: "Globex", Domain: "globex.com" },
    ],
  });
  // Give BOTH workspaces' contacts the SAME LinkedIn slug — the per-workspace uniq index allows it, and it is
  // the strongest cross-workspace-isolation probe: resolving the shared slug must return each workspace's OWN
  // row, never the other's.
  await admin`UPDATE contacts SET linkedin_public_id = 'jane-doe' WHERE workspace_id = ${wsA}`;
  await admin`UPDATE contacts SET linkedin_public_id = 'jane-doe' WHERE workspace_id = ${wsB}`;

  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("contactRepository.resolveByLinkedinPublicId — workspace isolation (X01)", () => {
  test("resolves the slug to THIS workspace's masked contact (non-PII)", async () => {
    const a = await db.contactRepository.resolveByLinkedinPublicId(
      { tenantId: tenantA, workspaceId: wsA },
      "jane-doe",
    );
    expect(a).not.toBeNull();
    expect(a?.id).toBe(await contactIdOf(wsA));
    expect(a?.firstName).toBe("Jane");
    expect(a?.isRevealed).toBe(false);
    // Masked projection — the plaintext email/phone are never on the DTO.
    expect(a as Record<string, unknown>).not.toHaveProperty("email");
    expect(a as Record<string, unknown>).not.toHaveProperty("phone");
  });

  test("the SAME slug resolves to each workspace's OWN row, never the other's", async () => {
    const a = await db.contactRepository.resolveByLinkedinPublicId(
      { tenantId: tenantA, workspaceId: wsA },
      "jane-doe",
    );
    const b = await db.contactRepository.resolveByLinkedinPublicId(
      { tenantId: tenantB, workspaceId: wsB },
      "jane-doe",
    );
    expect(a?.firstName).toBe("Jane");
    expect(b?.firstName).toBe("Bob");
    expect(a?.id).not.toBe(b?.id);
    expect(a?.id).toBe(await contactIdOf(wsA));
    expect(b?.id).toBe(await contactIdOf(wsB));
  });

  test("an unknown slug resolves to null", async () => {
    const r = await db.contactRepository.resolveByLinkedinPublicId(
      { tenantId: tenantA, workspaceId: wsA },
      "nobody-here",
    );
    expect(r).toBeNull();
  });

  test("a soft-deleted contact never resolves", async () => {
    await admin`UPDATE contacts SET deleted_at = now() WHERE workspace_id = ${wsA}`;
    const r = await db.contactRepository.resolveByLinkedinPublicId(
      { tenantId: tenantA, workspaceId: wsA },
      "jane-doe",
    );
    expect(r).toBeNull();
    await admin`UPDATE contacts SET deleted_at = NULL WHERE workspace_id = ${wsA}`;
  });
});
