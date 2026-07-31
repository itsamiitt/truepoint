// contributorIsolation.itest.ts — the C-02 proof. docs/strategy/08-architecture.md invariant 2:
// "Contributor anonymity by construction. Records never expose who contributed; contributor identity lives
// only in the provenance store, access-restricted." This file is what makes that a guarantee rather than a
// comment. On a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in
// its OWN process: `bun test ./packages/db/test/contributorIsolation.itest.ts`.
//
// The threat model, stated plainly: a seller must never be able to learn WHO corrected a record — not through
// the API, not by reading a field, not by joining two tables they can legitimately read. Contributor identity
// lives in forge.contributor (human decision 2026-07-31 D5 — reuse the shipped forge firewall rather than add
// a third least-privilege schema). What is asserted here:
//
//   (1) THE CUSTOMER ROLE CANNOT REACH IT — leadwolf_app is denied (42501) every DML verb on both tables. It
//       holds no grant anywhere in the forge schema, so no request served to a user can resolve a contributor.
//   (2) THE WRITER CANNOT RESOLVE WHAT IT WRITES — leadwolf_er appends provenance_event rows carrying
//       contributor_ref, and is ALSO denied on forge.contributor. The path that records the ref cannot turn it
//       back into a person. This is the sharp edge of invariant 2 and the assertion most likely to be broken
//       by a well-meaning future grant.
//   (3) THE REF IS STRUCTURALLY OPAQUE — provenance_event.contributor_ref has no FK, proven by storing a ref
//       that matches no contributor row and having the insert succeed. No referential coupling means no join
//       path from `public` into contributor identity, even for a role that could read both.
//   (4) TWO CHANNELS, TWO UNLINKABLE REFS — the (user_id, channel) unique means one human contributing over
//       two channels appears in the event log as two unrelated refs, so correlating them requires reaching
//       this table rather than just reading events.
//   (5) REVOCATION IS RECORDED, NOT ERASED — 09-compliance rule 5 requires revocation to stop future flow AND
//       be recorded; a deleted consent row cannot evidence that it was ever granted.
//   (6) THE ACCEPTED TRADE IS PINNED — leadwolf_forge CAN read these rows, because it holds DML on all tables
//       in its schema. That is the known cost of homing contributor in forge. Asserting it means a future
//       change to that posture shows up here as a failing test with a reason attached, rather than silently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501";
const CONTRIBUTOR_TABLES = ["forge.contributor", "forge.contributor_consent"] as const;

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantId = "";
let wsId = "";
let userId = "";
let masterPersonId = "";

/** Pull the Postgres SQLSTATE out of an error that a driver or ORM may have wrapped one or more layers deep. */
function pgCode(e: unknown): string {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return "";
}

beforeAll(async () => {
  dbHandle = await startItestDb("contributorIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('rep@acme.test') RETURNING id`;
  userId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${userId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${userId}) RETURNING id`;
  wsId = (w as { id: string }).id;

  const [mp] = await admin`INSERT INTO master_persons (full_name) VALUES ('Jane Prospect') RETURNING id`;
  masterPersonId = (mp as { id: string }).id;

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

// try/catch rather than expect(...).rejects: a postgres.js query is a lazy thenable, so handing the unawaited
// promise to .rejects never runs it — the assertion silently passes and the file hangs.
async function appDeniedCode(stmt: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsId}, true)`;
      await tx.unsafe(stmt);
    });
  } catch (e) {
    return pgCode(e);
  }
  return "";
}

async function erDeniedCode(stmt: string): Promise<string> {
  try {
    await dbmod.withErTx(async (tx) => {
      await tx.execute(sql.raw(stmt));
    });
  } catch (e) {
    return pgCode(e);
  }
  return "";
}

describe("contributor anonymity (invariant 2) — the C-02 wall", () => {
  // ── (1) THE CUSTOMER ROLE CANNOT REACH IT ─────────────────────────────────────────────────────────────────
  test("leadwolf_app is denied (42501) all DML on the contributor tables", async () => {
    for (const table of CONTRIBUTOR_TABLES) {
      expect(await appDeniedCode(`SELECT * FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`INSERT INTO ${table} DEFAULT VALUES`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`UPDATE ${table} SET id = id`)).toBe(PERMISSION_DENIED);
      expect(await appDeniedCode(`DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
    }
  });

  // ── (2) THE WRITER CANNOT RESOLVE WHAT IT WRITES ──────────────────────────────────────────────────────────
  // The sharpest assertion in the file. leadwolf_er records contributor_ref into provenance_event; if it could
  // also read forge.contributor, every ER job would be one join away from de-anonymising the whole network.
  test("leadwolf_er writes contributor_ref yet is denied (42501) on forge.contributor", async () => {
    for (const table of CONTRIBUTOR_TABLES) {
      expect(await erDeniedCode(`SELECT * FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
    }
  });

  // ── (3) THE REF IS STRUCTURALLY OPAQUE ────────────────────────────────────────────────────────────────────
  test("provenance_event.contributor_ref has no FK — a ref matching no contributor still inserts", async () => {
    // If an FK existed this would raise 23503, and its existence would mean a join path from `public` into
    // contributor identity for anyone holding both grants.
    const [row] = await admin`
      INSERT INTO provenance_event
        (entity_type, entity_id, field, action, source_type, lawful_basis, contributor_ref)
      VALUES ('person', ${masterPersonId}, 'jobTitle', 'confirm', 'extension', 'consent', gen_random_uuid())
      RETURNING contributor_ref`;
    expect((row as { contributor_ref: string | null }).contributor_ref).not.toBeNull();

    // And nothing in `public` references the forge tables, so there is no path to follow even as owner.
    const [fk] = await admin`
      SELECT count(*)::int AS n
        FROM pg_constraint c
        JOIN pg_class child  ON child.oid  = c.conrelid
        JOIN pg_class parent ON parent.oid = c.confrelid
        JOIN pg_namespace pn ON pn.oid = parent.relnamespace
       WHERE c.contype = 'f' AND pn.nspname = 'forge'
         AND child.relnamespace = 'public'::regnamespace`;
    expect((fk as { n: number }).n).toBe(0);
  });

  // ── (4) TWO CHANNELS, TWO UNLINKABLE REFS ─────────────────────────────────────────────────────────────────
  test("one human on two channels yields two distinct refs, and a channel cannot be double-registered", async () => {
    const [ext] = await admin`
      INSERT INTO forge.contributor (user_id, tenant_id, channel)
      VALUES (${userId}, ${tenantId}, 'extension') RETURNING id`;
    const [crm] = await admin`
      INSERT INTO forge.contributor (user_id, tenant_id, channel)
      VALUES (${userId}, ${tenantId}, 'crm_sync') RETURNING id`;
    expect((ext as { id: string }).id).not.toBe((crm as { id: string }).id);

    // The same (user, channel) twice is refused, so a second ref for one channel cannot be minted by accident.
    let dupCode = "";
    try {
      await admin`
        INSERT INTO forge.contributor (user_id, tenant_id, channel)
        VALUES (${userId}, ${tenantId}, 'extension')`;
    } catch (e) {
      dupCode = pgCode(e);
    }
    expect(dupCode).toBe("23505");
  });

  // ── (5) REVOCATION IS RECORDED, NOT ERASED ────────────────────────────────────────────────────────────────
  test("revoking consent retains the row and drops out of the live-consent index", async () => {
    const [c] = await admin`
      SELECT id FROM forge.contributor WHERE user_id = ${userId} AND channel = 'extension'`;
    const contributorId = (c as { id: string }).id;

    // JSON.stringify + an explicit ::jsonb cast, matching client.ts: postgres.js does not accept a bare
    // object as a bound parameter. It happened to work at runtime, which is exactly why only the test
    // typecheck (tsconfig.typecheck.json — the root typecheck task does not cover test files) caught it.
    await admin`
      INSERT INTO forge.contributor_consent (contributor_id, scope, policy_version)
      VALUES (${contributorId}, ${JSON.stringify({ channels: ["extension"] })}::jsonb, 'v1.0')`;

    const liveBefore = await admin`
      SELECT count(*)::int AS n FROM forge.contributor_consent
       WHERE contributor_id = ${contributorId} AND revoked_at IS NULL`;
    expect((liveBefore[0] as { n: number }).n).toBe(1);

    await admin`
      UPDATE forge.contributor_consent SET revoked_at = now() WHERE contributor_id = ${contributorId}`;

    const liveAfter = await admin`
      SELECT count(*)::int AS n FROM forge.contributor_consent
       WHERE contributor_id = ${contributorId} AND revoked_at IS NULL`;
    const retained = await admin`
      SELECT count(*)::int AS n, min(policy_version) AS v FROM forge.contributor_consent
       WHERE contributor_id = ${contributorId}`;
    expect((liveAfter[0] as { n: number }).n).toBe(0);
    // The evidence survives: revocation must not destroy the record that consent was ever granted, or under
    // which policy text.
    expect((retained[0] as { n: number; v: string }).n).toBe(1);
    expect((retained[0] as { n: number; v: string }).v).toBe("v1.0");
  });

  // ── (6) THE ACCEPTED TRADE, PINNED ────────────────────────────────────────────────────────────────────────
  test("leadwolf_forge CAN read contributor identity — the known cost of homing it in forge", async () => {
    // Not a desirable property; a documented one (decisions.md D5). Every forge worker runs as this role, so
    // contributor identity sits inside the blast radius of any forge job. Asserted so that tightening it later
    // is a deliberate change to a failing test rather than an invisible drift, in either direction.
    const n = await dbmod.withForgeTx(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM forge.contributor`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? -1;
    });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
