// erMerge.itest.ts — committing a reviewed ER match (06-roadmap Phase 2 "merge with provenance retention";
// outcome A-04 "same-person records don't diverge").
//
// The ER sweep could already PROPOSE matches and nothing could act on one. This covers the other half, and
// specifically the property that makes it auditable: provenance_event is APPEND-ONLY, so a merge cannot
// re-point the loser's assertions onto the survivor. It appends an action='merge' event instead and the reader
// follows the hop. A rewritten log cannot show you what it used to say, which is the question an A-04 audit
// asks a year later.
//
// Both failure modes here are silent, which is why they are tested against a real database: a half-merge
// leaves a tombstoned person whose evidence still resolves to it, and a double-merge appends a second merge
// event that makes the history read as two separate merges.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

const BASIS = "legitimate_interest";

async function makePerson(name: string): Promise<string> {
  const [r] = await admin`INSERT INTO master_persons (full_name) VALUES (${name}) RETURNING id`;
  return (r as { id: string }).id;
}

async function makeSourceRecord(personId: string, hash: number[]): Promise<string> {
  const [r] = await admin`
    INSERT INTO source_records (source_name, content_hash, raw_data, resolved_person_id)
    VALUES ('apollo', ${new Uint8Array(hash)}, '{}'::jsonb, ${personId}) RETURNING id`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("erMerge");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("erRepository.confirmMerge", () => {
  test("moves resolution to the survivor, tombstones the loser, and records BOTH sides", async () => {
    const survivor = await makePerson("Survivor One");
    const loser = await makePerson("Loser One");
    const sr = await makeSourceRecord(loser, [1, 1, 1, 1]);

    const res = await dbmod.withErTx((tx) =>
      dbmod.erRepository.confirmMerge(tx, { survivorId: survivor, loserId: loser, lawfulBasis: BASIS }),
    );
    expect(res.merged).toBe(true);
    expect(res.movedSourceRecords).toBe(1);

    // Resolution moved — a future lookup lands on the survivor.
    const [moved] = await admin`SELECT resolved_person_id AS p FROM source_records WHERE id = ${sr}`;
    expect((moved as { p: string }).p).toBe(survivor);

    // Loser tombstoned, pointing at where it went.
    const [t] = await admin`
      SELECT merged_into_person_id AS m, merged_at IS NOT NULL AS stamped
        FROM master_persons WHERE id = ${loser}`;
    expect((t as { m: string }).m).toBe(survivor);
    expect((t as { stamped: boolean }).stamped).toBe(true);

    // TWO merge events, not one. Reading the loser must show where it went; reading the survivor must show it
    // absorbed something. A single event leaves one of those two reads silently incomplete.
    const events = await admin`
      SELECT entity_id, payload FROM provenance_event
       WHERE action = 'merge' AND entity_id IN (${survivor}, ${loser}) ORDER BY entity_id`;
    expect(events.length).toBe(2);
    const byEntity = new Map(
      events.map((e) => [(e as { entity_id: string }).entity_id, (e as { payload: Record<string, string> }).payload]),
    );
    expect(byEntity.get(loser)?.mergedInto).toBe(survivor);
    expect(byEntity.get(survivor)?.absorbed).toBe(loser);
  });

  test("the loser's ORIGINAL assertions survive, still attached to the loser", async () => {
    // THE retention property. The evidence stays where it was made — the merge is a hop, not a rewrite. If a
    // future change starts re-pointing entity_id, this fails, and it should: the append-only trigger would
    // have to be weakened for that to even be possible.
    const survivor = await makePerson("Survivor Two");
    const loser = await makePerson("Loser Two");
    await admin`
      INSERT INTO provenance_event (entity_type, entity_id, field, action, source_type, lawful_basis)
      VALUES ('person', ${loser}, 'jobTitle', 'assert', 'provider', ${BASIS})`;

    await dbmod.withErTx((tx) =>
      dbmod.erRepository.confirmMerge(tx, { survivorId: survivor, loserId: loser, lawfulBasis: BASIS }),
    );

    const [kept] = await admin`
      SELECT count(*)::int AS n FROM provenance_event
       WHERE entity_id = ${loser} AND field = 'jobTitle' AND action = 'assert'`;
    expect((kept as { n: number }).n).toBe(1);
  });

  test("replaying a confirm is a no-op — no second merge, no second event", async () => {
    // A double-click or a retried job must not merge twice. A second merge event would make the history read
    // as two separate merges of the same pair.
    const survivor = await makePerson("Survivor Three");
    const loser = await makePerson("Loser Three");

    const first = await dbmod.withErTx((tx) =>
      dbmod.erRepository.confirmMerge(tx, { survivorId: survivor, loserId: loser, lawfulBasis: BASIS }),
    );
    const second = await dbmod.withErTx((tx) =>
      dbmod.erRepository.confirmMerge(tx, { survivorId: survivor, loserId: loser, lawfulBasis: BASIS }),
    );
    expect(first.merged).toBe(true);
    expect(second.merged).toBe(false);

    const [n] = await admin`
      SELECT count(*)::int AS n FROM provenance_event WHERE action = 'merge' AND entity_id = ${loser}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("merging a person into itself is refused before it reaches the database", async () => {
    const p = await makePerson("Self");
    let msg = "";
    try {
      await dbmod.withErTx((tx) =>
        dbmod.erRepository.confirmMerge(tx, { survivorId: p, loserId: p, lawfulBasis: BASIS }),
      );
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Named at the caller rather than surfacing as a CHECK violation — the constraint is the backstop, not
    // the error message a developer should have to decode.
    expect(msg).toMatch(/same person/i);
  });

  test("the database refuses a self-merge even if the guard is bypassed", async () => {
    const p = await makePerson("SelfDb");
    let code = "";
    try {
      await admin`UPDATE master_persons SET merged_into_person_id = ${p} WHERE id = ${p}`;
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("23514"); // check_violation — a record that resolves to itself forever is unreachable
  });
});
