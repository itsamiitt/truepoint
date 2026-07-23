// forgeParserSeed.itest.ts — proves P-01.1 is fixed. Migration 0071 seeds the ONE built-in voyager parser into
// forge.parser_versions at the SAME uuid the in-memory registry uses (VOYAGER_PROFILE_VERSION_ID), so
// forge.parsed_records.parser_version_id (a uuid FK to forge.parser_versions) RESOLVES and the parse-stage upsert
// succeeds — instead of failing on the uuid cast + FK violation it hit when the registry wrote a string id
// ("voyager-profile-1-0-0") against an empty table. Runs on a real Postgres (Testcontainers by default, or an
// external server via ITEST_DATABASE_URL — see itestDb.ts), in its OWN process (the db client is a module
// singleton): `bun test ./packages/db/test/forgeParserSeed.itest.ts`. The write path runs under withForgeTx
// (SET LOCAL ROLE leadwolf_forge), mirroring the worker's makeParseProcessor exactly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VOYAGER_PROFILE_PARSER_ID, VOYAGER_PROFILE_VERSION_ID } from "@leadwolf/forge-core";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeParserSeed");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // applies through 0071 → seeds forge.parser_versions

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("forge parser registry seed ↔ parsed_records FK (P-01.1)", () => {
  // ── TEST 1: THE SEED — migration 0071 wrote the active version at the registry's uuid ─────────────────────────
  test("0071 seeds the active voyager parser_version at VOYAGER_PROFILE_VERSION_ID", async () => {
    const [pv] = await admin`
      SELECT id::text, parser_id::text, version, status
        FROM forge.parser_versions WHERE id = ${VOYAGER_PROFILE_VERSION_ID}`;
    const row = pv as { id: string; parser_id: string; version: string; status: string };
    expect(row.id).toBe(VOYAGER_PROFILE_VERSION_ID);
    expect(row.parser_id).toBe(VOYAGER_PROFILE_PARSER_ID);
    expect(row.version).toBe("1-0-0");
    expect(row.status).toBe("active");
  });

  // ── TEST 2: THE FK RESOLVES — upsertParsedRecord with the registry uuid succeeds (was: uuid-cast + FK error) ──
  test("upsertParsedRecord with the registry uuid resolves the FK and is idempotent", async () => {
    // a bronze row to satisfy parsed_records.raw_capture_id → raw_captures(id).
    const [rc] = await admin`
      INSERT INTO forge.raw_captures
        (source, endpoint, schema_version, content_hash, target_tenant_id, payload_inline, byte_size)
      VALUES ('chrome_extension', 'voyager/identity/profiles', '1-0-0',
              ${`hash-${VOYAGER_PROFILE_VERSION_ID}`}, '00000000-0000-4000-8000-0000000000aa', '{}', 2)
      RETURNING id::text`;
    const rawCaptureId = (rc as { id: string }).id;

    const upsert = () =>
      dbmod.withForgeTx((tx) =>
        dbmod.upsertParsedRecord(tx, {
          rawCaptureId,
          parserVersionId: VOYAGER_PROFILE_VERSION_ID,
          parseStatus: "parsed",
          fields: [],
          fieldProvenance: [],
          parseErrors: [],
        }),
      );

    expect((await upsert()).written).toBe(true); // the FK now resolves — this is P-01.1 fixed
    expect((await upsert()).written).toBe(true); // idempotent on (raw_capture_id, parser_version_id)

    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM forge.parsed_records WHERE raw_capture_id = ${rawCaptureId}`;
    expect((cnt as { n: number }).n).toBe(1); // a re-derivation converged, did not duplicate
  });
});
