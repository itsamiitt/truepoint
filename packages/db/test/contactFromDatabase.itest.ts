// contactFromDatabase.itest.ts — reveal-as-save's LANDING half on a real Postgres 16 (decisions.md 2026-08-25;
// [S-06][S-04][A-01]): materializing a database person is idempotent (a second add of an unchanged person is
// `known` and writes nothing), lands with the Layer-0 bridge and vendor-neutral provenance (rule 5), moves no
// channel VALUE, persists the Layer-0 channel PRESENCE bits (0139), and the workspace search projection folds
// them into hasEmail/hasPhone — so the grid keeps offering the OTHER channel's reveal after one is revealed.
// Testcontainers by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Named *.itest.ts
// so default `bun test` skips it; run explicitly: `bun test packages/db/test/contactFromDatabase.itest.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let core: Core;
let db: Db;
let admin: ReturnType<typeof postgres>;
let tenantId = "";
let workspaceId = "";
let userId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("contact_from_database");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  tenantId = (t as { id: string }).id;
  userId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${tenantId}, ${userId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${userId}) RETURNING id`;
  workspaceId = (w as { id: string }).id;

  // A visible (licensed) person with both channels on file, at a company with a registrable domain — and a
  // private (workspace-minted) one the predicate must hide.
  const [co] = await admin`
    INSERT INTO master_companies (name, name_normalized, primary_domain, org_kind, field_provenance)
    VALUES ('Acme', 'acme', 'acme.com', 'company', '{"name":{}}'::jsonb) RETURNING id`;
  await admin`
    INSERT INTO master_persons
      (linkedin_public_id, full_name, first_name, last_name, job_title, visibility,
       has_email, has_phone, current_company_id)
    VALUES
      ('jane-licensed', 'Jane Licensed', 'Jane', 'Licensed', 'VP Sales', 'licensed',
       true, true, ${(co as { id: string }).id})`;
  await admin`
    INSERT INTO master_persons (linkedin_public_id, full_name, visibility)
    VALUES ('pat-private', 'Pat Private', 'private')`;
}, 180_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scope = () => ({ tenantId, workspaceId, capturedByUserId: userId });

describe("materializeContactFromMaster — the landing half of reveal-as-save", () => {
  test("lands a licensed person with the bridge, the presence bits, provenance — and no channel VALUE", async () => {
    const first = await core.materializeContactFromMaster(scope(), {
      linkedinPublicId: "jane-licensed",
    });
    expect(first.outcome).toBe("created");
    expect(first.contactId).not.toBeNull();
    expect(first.presence).toEqual({ hasEmail: true, hasPhone: true });

    const [row] = await admin`
      SELECT master_person_id, master_has_email, master_has_phone, email_enc, phone_enc,
             field_provenance, linkedin_public_id
        FROM contacts WHERE id = ${first.contactId as string}`;
    const r = row as {
      master_person_id: string | null;
      master_has_email: boolean | null;
      master_has_phone: boolean | null;
      email_enc: unknown;
      phone_enc: unknown;
      field_provenance: unknown;
      linkedin_public_id: string | null;
    };
    expect(r.master_person_id).not.toBeNull();
    expect(r.linkedin_public_id).toBe("jane-licensed");
    expect(r.master_has_email).toBe(true);
    expect(r.master_has_phone).toBe(true);
    // A landing moves profile facts only — the channel values are the paid product (A-01/A-03).
    expect(r.email_enc).toBeNull();
    expect(r.phone_enc).toBeNull();
    // Vendor-neutral provenance by construction (rule 5): the workspace learns "the TruePoint database".
    expect(JSON.stringify(r.field_provenance)).toContain('"src":"master"');
    const [imp] = await admin`
      SELECT source_name FROM source_imports WHERE contact_id = ${first.contactId as string}`;
    expect((imp as { source_name: string }).source_name).toBe("database");
  });

  test("a second add of the unchanged person is `known` and creates nothing", async () => {
    const again = await core.materializeContactFromMaster(scope(), {
      linkedinPublicId: "jane-licensed",
    });
    expect(again.outcome).toBe("known");
    const rows = await admin`
      SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${workspaceId}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  test("the workspace search projection folds the presence bits into hasEmail/hasPhone (0139)", async () => {
    const page = await db.searchRepository.searchContacts(
      { tenantId, workspaceId },
      { filters: [], sort: "relevance", limit: 50 },
    );
    const jane = page.hits.find((h) => h.linkedinPublicId === "jane-licensed");
    expect(jane).toBeDefined();
    // No value is held locally, yet the platform has both — so both reveal buttons stay on offer.
    expect(jane?.hasEmail).toBe(true);
    expect(jane?.hasPhone).toBe(true);
    expect(jane?.isRevealed).toBe(false);
  });

  test("a private (workspace-minted) person is indistinguishable from absent", async () => {
    const res = await core.materializeContactFromMaster(scope(), {
      linkedinPublicId: "pat-private",
    });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("not_in_database");
    expect(res.presence).toBeUndefined();
  });
});
