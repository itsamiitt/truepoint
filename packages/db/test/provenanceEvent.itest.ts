// provenanceEvent.itest.ts — the structural proofs for `provenance_event`, the field-grain assertion log behind
// docs/strategy/08-architecture.md invariant 1 ("nothing writes to the materialized graph except through a
// provenance_event") and outcome A-01. On a real Postgres 16 (Testcontainers by default, or an external server
// via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module singleton):
// `bun test ./packages/db/test/provenanceEvent.itest.ts`.
//
// These encode the S-02 acceptance criteria as executable assertions rather than prose:
//   (1) THE GRANT-OFF WALL — leadwolf_app is DENIED (42501) every DML verb. provenance_event is Layer-0-shaped
//       (no workspace_id ⇒ no writable RLS predicate) AND carries contributor_ref, so grant-off is the wall,
//       exactly as for master_* (rls/provenanceEvent.sql, applyMigrations GRANTS).
//   (2) LAWFUL BASIS IS MANDATORY — an insert without one is refused by the database, not by a code path that
//       can be forgotten. 09-compliance rule 4: anything untaggable does not enter the graph. [A-01]
//   (3) CLOSED VOCABULARIES — entity_type / action / source_type / lawful_basis / acceptance_state reject
//       anything outside their enum, so a typo cannot quietly create a new provenance category.
//   (4) APPEND-ONLY FOR EVERY ROLE, owner included — an audit log that can be rewritten is not evidence, and
//       both A-01 and A-03 rest on this table being evidence.
//   (5) THE ONE SANCTIONED MUTATION — source_record_id's ON DELETE SET NULL, so an assertion outlives the
//       payload retention reaps at 730d. Every other column must stay byte-identical.
//   (6) LAYER/SCOPE CORRESPONDENCE — an overlay event must carry scope_ref, a Layer-0 event must not. This is
//       what stops a Layer-0 event from silently carrying a tenant hint (C-02).
//   (7) PARTITIONED, AND THE SWEEP FINDS IT — the maintenance sweep is catalog-driven, so being relkind 'p' in
//       `public` is the whole registration. If this regresses, writes start failing on the 1st of a month.
//   (8) THE WRITER AND D7's ATOMICITY — an event and the evidence it derives from live or die together, and
//       the ev.created contract really does stop a re-ingest doubling the corroboration count. That contract
//       cannot be an index (the table is partitioned, so a unique would have to include recorded_at), so the
//       guard IS the mechanism and this is the only thing that proves it holds.

import type { ProvenanceEventDraft } from "@leadwolf/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501"; // insufficient_privilege — the grant-off wall
const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";
const RAISED_EXCEPTION = "P0001"; // plpgsql RAISE EXCEPTION — the append-only trigger

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantId = "";
let wsId = "";
let masterPersonId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("provenanceEvent");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${ownerId}) RETURNING id`;
  wsId = (w as { id: string }).id;

  const [mp] = await admin`INSERT INTO master_persons (full_name) VALUES ('Jane Prospect') RETURNING id`;
  masterPersonId = (mp as { id: string }).id;

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

// Run one statement as leadwolf_app inside a fully-GUC'd tenant tx and return the SQLSTATE it threw (or "").
// try/catch, NOT expect(...).rejects: a postgres.js query is a lazy thenable, so handing the unawaited promise
// to .rejects never executes it and the file hangs instead of failing.
async function deniedCode(stmt: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${wsId}, true)`;
      await tx.unsafe(stmt);
    });
  } catch (e) {
    return (e as { code?: string }).code ?? "";
  }
  return "";
}

/** Same shape, on the privileged owner connection — for constraint/trigger proofs that are not about grants. */
async function ownerErrCode(stmt: string): Promise<string> {
  try {
    await admin.unsafe(stmt);
  } catch (e) {
    return (e as { code?: string }).code ?? "";
  }
  return "";
}

/** A minimal valid Layer-0 event, with the named column overridden — or omitted entirely, by passing
 *  `undefined`, which is how the NOT NULL proof drops lawful_basis without hand-writing a second statement. */
function insertLayer0(overrides: Record<string, string | undefined> = {}): string {
  const cols: Record<string, string | undefined> = {
    entity_type: "'person'",
    entity_id: `'${masterPersonId}'::uuid`,
    field: "'jobTitle'",
    action: "'assert'",
    source_type: "'provider'",
    lawful_basis: "'legitimate_interest'",
    ...overrides,
  };
  const present = Object.entries(cols).filter((e): e is [string, string] => e[1] !== undefined);
  const names = present.map(([k]) => k).join(", ");
  const values = present.map(([, v]) => v).join(", ");
  return `INSERT INTO provenance_event (${names}) VALUES (${values})`;
}

/** A valid Layer-0 draft for the repository-level tests, as the writer would build it. */
function draft(field: string, sourceRecordId: string | null): ProvenanceEventDraft {
  return {
    entityType: "person",
    entityId: masterPersonId,
    field,
    action: "assert",
    sourceType: "import",
    sourceName: "import:apollo",
    method: "deterministic",
    contributorRef: null,
    lawfulBasis: "legitimate_interest",
    payload: {},
    confidence: null,
    acceptanceState: "accepted",
    sourceRecordId,
    scopeRef: null,
    observedAt: null,
  };
}

describe("provenance_event — invariant 1 structural proofs", () => {
  // ── (1) THE GRANT-OFF WALL ────────────────────────────────────────────────────────────────────────────────
  test("leadwolf_app is denied (42501) ALL DML on provenance_event — read AND write", async () => {
    // Read matters as much as write here: even though contributor_ref is unresolvable outside the provenance
    // schema, letting the customer role read per-record contribution patterns would erode C-02 by correlation.
    expect(await deniedCode("SELECT * FROM provenance_event LIMIT 1")).toBe(PERMISSION_DENIED);
    expect(await deniedCode("INSERT INTO provenance_event DEFAULT VALUES")).toBe(PERMISSION_DENIED);
    expect(await deniedCode("UPDATE provenance_event SET field = field")).toBe(PERMISSION_DENIED);
    expect(await deniedCode("DELETE FROM provenance_event")).toBe(PERMISSION_DENIED);
  });

  // ── (2) LAWFUL BASIS IS MANDATORY [A-01] ──────────────────────────────────────────────────────────────────
  test("an event without a lawful basis is refused by the database", async () => {
    expect(await ownerErrCode(insertLayer0({ lawful_basis: undefined }))).toBe(NOT_NULL_VIOLATION);
  });

  // ── (3) CLOSED VOCABULARIES ───────────────────────────────────────────────────────────────────────────────
  test("every closed vocabulary rejects a value outside its enum", async () => {
    expect(await ownerErrCode(insertLayer0({ entity_type: "'organisation'" }))).toBe(CHECK_VIOLATION);
    expect(await ownerErrCode(insertLayer0({ action: "'upsert'" }))).toBe(CHECK_VIOLATION);
    expect(await ownerErrCode(insertLayer0({ source_type: "'scrape'" }))).toBe(CHECK_VIOLATION);
    expect(await ownerErrCode(insertLayer0({ lawful_basis: "'vibes'" }))).toBe(CHECK_VIOLATION);
    expect(await ownerErrCode(insertLayer0({ acceptance_state: "'maybe'" }))).toBe(CHECK_VIOLATION);
    expect(await ownerErrCode(insertLayer0({ confidence: "1.5" }))).toBe(CHECK_VIOLATION);
  });

  // ── (6) LAYER/SCOPE CORRESPONDENCE (C-02) ─────────────────────────────────────────────────────────────────
  test("an overlay event must carry scope_ref and a Layer-0 event must not", async () => {
    // Layer 0 with a workspace hint — refused.
    expect(await ownerErrCode(insertLayer0({ scope_ref: `'${wsId}'::uuid` }))).toBe(CHECK_VIOLATION);
    // Overlay with no workspace — refused.
    expect(
      await ownerErrCode(
        insertLayer0({ entity_type: "'contact'", entity_id: "gen_random_uuid()" }),
      ),
    ).toBe(CHECK_VIOLATION);
    // Overlay WITH a workspace — accepted.
    expect(
      await ownerErrCode(
        insertLayer0({
          entity_type: "'contact'",
          entity_id: "gen_random_uuid()",
          scope_ref: `'${wsId}'::uuid`,
        }),
      ),
    ).toBe("");
  });

  // ── (4) APPEND-ONLY, OWNER INCLUDED ───────────────────────────────────────────────────────────────────────
  test("UPDATE and DELETE raise for the owner connection, not just for leadwolf_app", async () => {
    await admin.unsafe(insertLayer0({ field: "'department'" }));
    expect(
      await ownerErrCode("UPDATE provenance_event SET field = 'seniority' WHERE field = 'department'"),
    ).toBe(RAISED_EXCEPTION);
    expect(await ownerErrCode("DELETE FROM provenance_event WHERE field = 'department'")).toBe(
      RAISED_EXCEPTION,
    );
  });

  // ── (5) THE ONE SANCTIONED MUTATION ───────────────────────────────────────────────────────────────────────
  test("retention reaping a source_record nulls the pointer and leaves every other column intact", async () => {
    const [sr] = await admin`
      INSERT INTO source_records (source_name, content_hash, raw_data)
      VALUES ('apollo', '\\xFEEDFACE'::bytea, '{"seed":true}'::jsonb) RETURNING id`;
    const sourceRecordId = (sr as { id: string }).id;

    await admin.unsafe(
      insertLayer0({ field: "'locationCity'", source_record_id: `'${sourceRecordId}'::uuid` }),
    );
    const [before] = await admin`
      SELECT to_jsonb(p) - 'source_record_id' AS rest FROM provenance_event p WHERE field = 'locationCity'`;

    // The FK's ON DELETE SET NULL fires an UPDATE the append-only trigger must sanction.
    await admin`DELETE FROM source_records WHERE id = ${sourceRecordId}`;

    const [after] = await admin`
      SELECT source_record_id, to_jsonb(p) - 'source_record_id' AS rest
        FROM provenance_event p WHERE field = 'locationCity'`;
    expect((after as { source_record_id: string | null }).source_record_id).toBeNull();
    // Byte-identical apart from the pointer — the assertion survived its payload.
    expect((after as { rest: unknown }).rest).toEqual((before as { rest: unknown }).rest);
  });

  // ── (8) THE WRITER, AND D7's ATOMICITY GUARANTEE ──────────────────────────────────────────────────────────
  // The whole point of decision D7: an event and the evidence it derives from live or die together. If they
  // could diverge, the graph could hold a fact whose assertion was lost, and invariant 1 would be a goal
  // rather than a guarantee.
  test("appendProvenanceEvents writes under leadwolf_er, atomically with the evidence row", async () => {
    const contentHash = new Uint8Array([1, 2, 3, 4]);
    const written = await dbmod.withErTx(async (tx) => {
      const ev = await dbmod.evidenceRepository.appendSourceRecord(tx, {
        sourceName: "apollo",
        contentHash,
        rawData: { seed: "atomicity" },
      });
      expect(ev?.created).toBe(true);
      // Deliberately synthetic field names: earlier tests in this file leave rows behind (the append-only
      // trigger means nothing can clean up), so reusing a real field name would make these counts depend on
      // execution order rather than on the behaviour under test.
      return dbmod.evidenceRepository.appendProvenanceEvents(tx, [
        draft("ev_atomic_a", ev?.id ?? null),
        draft("ev_atomic_b", ev?.id ?? null),
      ]);
    });
    expect(written).toBe(2);

    const [n] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE field IN ('ev_atomic_a','ev_atomic_b')`;
    expect((n as { n: number }).n).toBe(2);
  });

  test("a failure after the append rolls the events back with the evidence", async () => {
    const contentHash = new Uint8Array([9, 9, 9, 9]);
    let threw = false;
    try {
      await dbmod.withErTx(async (tx) => {
        const ev = await dbmod.evidenceRepository.appendSourceRecord(tx, {
          sourceName: "apollo",
          contentHash,
          rawData: { seed: "rollback" },
        });
        await dbmod.evidenceRepository.appendProvenanceEvents(tx, [
          draft("ev_rollback", ev?.id ?? null),
        ]);
        throw new Error("simulated downstream failure");
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Neither half survived — that is the guarantee. A surviving event would mean an assertion about a payload
    // no evidence row records; a surviving evidence row would mean a payload whose assertions were lost.
    const [events] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE field = 'ev_rollback'`;
    const [records] = await admin`
      SELECT count(*)::int AS n FROM source_records WHERE content_hash = ${contentHash}`;
    expect((events as { n: number }).n).toBe(0);
    expect((records as { n: number }).n).toBe(0);
  });

  test("the ev.created contract is what stops a re-ingest doubling the corroboration count", async () => {
    // provenance_event is partitioned, so no unique index can enforce this — the guard IS the mechanism. This
    // asserts the contract holds end to end: ingest the same payload twice, honouring created, and the field is
    // asserted exactly once. Without it the count would read 2 and every confidence score downstream would be
    // wrong, silently and permanently.
    const contentHash = new Uint8Array([7, 7, 7, 7]);
    const ingest = async () =>
      dbmod.withErTx(async (tx) => {
        const ev = await dbmod.evidenceRepository.appendSourceRecord(tx, {
          sourceName: "apollo",
          contentHash,
          rawData: { seed: "idempotent" },
        });
        if (!ev || !ev.created) return 0; // the contract
        return dbmod.evidenceRepository.appendProvenanceEvents(tx, [draft("ev_idempotent", ev.id)]);
      });

    expect(await ingest()).toBe(1);
    expect(await ingest()).toBe(0); // second pass: same payload, no new assertions

    const [n] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE field = 'ev_idempotent'`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("an empty batch is a no-op so callers need no guard", async () => {
    const written = await dbmod.withErTx((tx) =>
      dbmod.evidenceRepository.appendProvenanceEvents(tx, []),
    );
    expect(written).toBe(0);
  });

  // ── (7) PARTITIONED, AND THE SWEEP FINDS IT ───────────────────────────────────────────────────────────────
  test("provenance_event is range-partitioned and the catalog-driven sweep picks it up", async () => {
    const [rel] = await admin`
      SELECT relkind::text AS kind FROM pg_class
       WHERE relname = 'provenance_event' AND relnamespace = 'public'::regnamespace`;
    expect((rel as { kind: string }).kind).toBe("p");

    // The sweep asks the catalog rather than carrying a list, so appearing here IS the registration.
    const tables = await dbmod.partitionRepository.listPartitionedTables();
    expect(tables).toContain("public.provenance_event");

    // A DEFAULT partition exists, so a lapsed sweep degrades to "rows land in the catch-all" rather than
    // "writes fail on the 1st".
    const [def] = await admin`
      SELECT count(*)::int AS n FROM pg_class WHERE relname = 'provenance_event_default'`;
    expect((def as { n: number }).n).toBe(1);
  });
});
