// pipelineStages.itest.ts — the G-REV-7 / ADR-0028 Definition-of-Done proof on a real Postgres 16
// (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN
// process (the db client is a module singleton): `bun test ./packages/db/test/pipelineStages.itest.ts`.
//
// Proves: (1) stages are created mapping to canonical outreach_status values; (2) assigning a contact to a
// stage ROLLS its outreach_status up to the stage's maps_to_status in the same tx; (3) clearing the stage
// drops the assignment but leaves the canonical status untouched (one-way rollup); (4) an invalid mapping is
// rejected — at the DB by the CHECK that mirrors the canonical enum (the Zod enum is the edge backstop);
// (5) per-WORKSPACE RLS isolation: workspace B can neither see nor assign workspace A's stage, and assigning
// a foreign stage to one's own contact is refused (RLS hides the stage → NotFound); (6) deleting a stage
// SET NULLs the contact's pipeline_stage_id while leaving the rolled-up outreach_status as-is.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
let tenantA = "";
let wsA = "";
let ownerA = "";
let tenantB = "";
let wsB = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

async function contactRow(
  contactId: string,
): Promise<{ outreach_status: string; pipeline_stage_id: string | null }> {
  const [r] = await admin`
    SELECT outreach_status, pipeline_stage_id FROM contacts WHERE id = ${contactId}`;
  return r as { outreach_status: string; pipeline_stage_id: string | null };
}

/** Run a rejecting call once and hand back the error (typed loosely for code/message assertions). */
async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("pipeline-stages");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  // env is set above, BEFORE these dynamic imports load @leadwolf/config / the db singleton.
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");

  // Seed one contact per workspace (default outreach_status = 'new').
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: [
      {
        Email: "jane@acme.com",
        "First Name": "Jane",
        "Last Name": "Doe",
        Company: "Acme",
        Domain: "acme.com",
      },
    ],
  });
  await core.runImport({
    scope: { tenantId: tenantB, workspaceId: wsB },
    sourceName: "manual",
    mapping: MAPPING,
    rows: [
      {
        Email: "mark@globex.com",
        "First Name": "Mark",
        "Last Name": "Roe",
        Company: "Globex",
        Domain: "globex.com",
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("G-REV-7 pipeline-stage layer: mapping invariant, rollup, and per-workspace RLS isolation", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });
  let stageMeetingA = ""; // wsA stage mapping to 'meeting_booked'
  let stageDefaultA = ""; // wsA default stage mapping to 'new'

  test("stages are created mapping to canonical statuses; default is exclusive", async () => {
    const def = await core.createStage({
      scope: scopeA(),
      name: "Lead",
      mapsToStatus: "new",
      isDefault: true,
    });
    stageDefaultA = def.id;
    const meeting = await core.createStage({
      scope: scopeA(),
      name: "Demo booked",
      mapsToStatus: "meeting_booked",
    });
    stageMeetingA = meeting.id;

    const stages = await db.pipelineStageRepository.list(scopeA());
    expect(stages.map((s) => s.name)).toEqual(["Lead", "Demo booked"]); // ordering 0,1 (append)
    expect(stages[0]!.ordering).toBe(0);
    expect(stages[1]!.ordering).toBe(1);
    expect(stages.find((s) => s.id === stageDefaultA)!.mapsToStatus).toBe("new");
    expect(stages.find((s) => s.id === stageMeetingA)!.mapsToStatus).toBe("meeting_booked");

    // Promoting a second stage to default clears the first (at most one default per workspace).
    await core.updateStage({ scope: scopeA(), stageId: stageMeetingA, isDefault: true });
    const after = await db.pipelineStageRepository.list(scopeA());
    expect(after.filter((s) => s.isDefault).map((s) => s.id)).toEqual([stageMeetingA]);
  });

  test("assigning a contact to a stage rolls outreach_status up to the stage's mapping (same tx)", async () => {
    const jane = await contactIdByDomain(wsA, "acme.com");
    expect((await contactRow(jane)).outreach_status).toBe("new"); // import default

    const result = await core.assignStage({
      scope: scopeA(),
      contactId: jane,
      stageId: stageMeetingA,
    });
    expect(result.outreachStatus).toBe("meeting_booked");
    expect(result.stageId).toBe(stageMeetingA);

    const row = await contactRow(jane);
    expect(row.pipeline_stage_id).toBe(stageMeetingA);
    expect(row.outreach_status).toBe("meeting_booked"); // rolled up to the stage's maps_to_status
  });

  test("clearing the stage drops the assignment but leaves outreach_status untouched (one-way rollup)", async () => {
    const jane = await contactIdByDomain(wsA, "acme.com");
    const result = await core.assignStage({ scope: scopeA(), contactId: jane, stageId: null });
    expect(result.stageId).toBeNull();
    expect(result.outreachStatus).toBe("meeting_booked"); // unchanged — we never silently reset to "new"

    const row = await contactRow(jane);
    expect(row.pipeline_stage_id).toBeNull();
    expect(row.outreach_status).toBe("meeting_booked");
  });

  test("an invalid maps_to_status is rejected at the DB by the canonical-enum CHECK", async () => {
    // Direct admin insert bypasses the Zod edge guard, so this proves the DB CHECK (the backstop) holds the
    // mapping invariant: only the seven canonical outreach_status values are storable.
    const err = await caught(
      () => admin`
        INSERT INTO pipeline_stages (tenant_id, workspace_id, name, maps_to_status)
        VALUES (${tenantA}, ${wsA}, 'Bogus', 'totally_not_canonical')`,
    );
    expect(String(err.message)).toContain("pipeline_stages_maps_to_status_enum");
  });

  test("per-workspace RLS isolation: B cannot see A's stages, and cannot reach them across workspaces", async () => {
    // B lists its OWN stages — A's two stages never appear.
    const listB = await db.pipelineStageRepository.list(scopeB());
    expect(listB.map((s) => s.id)).not.toContain(stageMeetingA);
    expect(listB.map((s) => s.id)).not.toContain(stageDefaultA);

    // B's contact assigned to A's stage id → the stage is invisible under B's RLS scope → NotFound, and B's
    // contact is left untouched (no cross-workspace status leak).
    const mark = await contactIdByDomain(wsB, "globex.com");
    const err = await caught(() =>
      core.assignStage({ scope: scopeB(), contactId: mark, stageId: stageMeetingA }),
    );
    expect(err.code).toBe("not_found");
    const row = await contactRow(mark);
    expect(row.pipeline_stage_id).toBeNull();
    expect(row.outreach_status).toBe("new");
  });

  test("deleting a stage SET NULLs the contact's pipeline_stage_id but leaves outreach_status", async () => {
    const jane = await contactIdByDomain(wsA, "acme.com");
    // Re-assign jane to a fresh stage, then delete the stage and prove the FK SET NULL fires.
    const drop = await core.createStage({ scope: scopeA(), name: "Temp", mapsToStatus: "replied" });
    await core.assignStage({ scope: scopeA(), contactId: jane, stageId: drop.id });
    expect((await contactRow(jane)).outreach_status).toBe("replied");

    await admin`DELETE FROM pipeline_stages WHERE id = ${drop.id}`;
    const row = await contactRow(jane);
    expect(row.pipeline_stage_id).toBeNull(); // FK ON DELETE SET NULL
    expect(row.outreach_status).toBe("replied"); // the rollup is NOT reverted on stage delete
  });
});
