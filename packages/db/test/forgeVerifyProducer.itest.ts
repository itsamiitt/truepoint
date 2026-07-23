// forgeVerifyProducer.itest.ts — proves the P-01.10 producer's DB primitives. getVerifyInputs assembles the
// silver inputs for a capture (parsed fields + channel blind indexes + the capturer=four-eyes MAKER + the AI
// extraction band/confidence signal). insertApprovalRequest persists the SERVER-authoritative approval and is
// idempotent on (op_class, subject_ref) among PENDING rows, so a redelivered verify converges instead of piling
// up duplicate approvals. Real Postgres (Testcontainers / ITEST_DATABASE_URL); writes under withForgeTx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

// Seeded by migration 0074_seed_forge_voyager_parser (parsed_records.parser_version_id FK).
const VOYAGER_VERSION_ID = "a0000000-0000-4000-8000-000000000002";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeVerifyProducer");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // through 0079 → approval_requests.subject_ref + the partial unique
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

async function seedCapture(capturedBy: string | null): Promise<string> {
  const [rc] = await admin`
    INSERT INTO forge.raw_captures
      (source, endpoint, schema_version, content_hash, target_tenant_id, captured_by_user_id, payload_inline, byte_size)
    VALUES ('chrome_extension', 'voyager/identity/profiles', '1-0-0',
            ${`h-${crypto.randomUUID()}`}, '00000000-0000-4000-8000-0000000000aa', ${capturedBy}, '{}', 2)
    RETURNING id::text`;
  return (rc as { id: string }).id;
}

describe("verify producer DB primitives (P-01.10)", () => {
  test("getVerifyInputs returns parsed fields, the capturer (maker), and the extraction signal", async () => {
    const capturer = crypto.randomUUID();
    const rc = await seedCapture(capturer);
    await admin`
      INSERT INTO forge.parsed_records
        (raw_capture_id, parser_version_id, entity_kind, fields, parse_status, email_blind_index)
      VALUES (${rc}, ${VOYAGER_VERSION_ID}, 'person',
              ${JSON.stringify([{ path: "full_name", value: "Ada" }])}::jsonb, 'ok', 'eb-hex')`;
    await admin`
      INSERT INTO forge.extraction_candidates (raw_capture_id, path, value, confidence, band, grounded)
      VALUES (${rc}, 'current_title', ${JSON.stringify("VP Eng")}::jsonb, 0.91, 'auto', true),
             (${rc}, 'location',      ${JSON.stringify("NYC")}::jsonb,    0.40, 'quarantine', true)`;

    const inputs = await dbmod.withForgeTx((tx) => dbmod.getVerifyInputs(tx, rc));
    expect(inputs).not.toBeNull();
    expect(inputs?.entityKind).toBe("person");
    expect(inputs?.capturedByUserId).toBe(capturer); // the four-eyes maker, server-sourced
    expect(inputs?.emailBlindIndex).toBe("eb-hex");
    expect(inputs?.extractions.length).toBe(2);
    const auto = inputs?.extractions.filter((e) => e.band === "auto") ?? [];
    expect(auto.map((e) => e.confidence)).toEqual([0.91]); // the auto-band signal the confidence floor uses
  });

  test("getVerifyInputs is null when the capture has no parsed record", async () => {
    const rc = await seedCapture(crypto.randomUUID());
    const inputs = await dbmod.withForgeTx((tx) => dbmod.getVerifyInputs(tx, rc));
    expect(inputs).toBeNull();
  });

  test("insertApprovalRequest is idempotent on (op_class, subject_ref) among pending rows", async () => {
    const maker = crypto.randomUUID();
    const contentHash = `ch-${crypto.randomUUID()}`;
    const put = () =>
      dbmod.withForgeTx((tx) =>
        dbmod.insertApprovalRequest(tx, {
          opClass: "verify.promote",
          requestedByUserId: maker,
          subjectRef: contentHash,
          payload: { contentHash, entityKind: "person" },
        }),
      );
    const id1 = await put();
    const id2 = await put(); // redelivered verify
    expect(id1).toBe(id2); // same request, not a duplicate

    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM forge.approval_requests WHERE subject_ref = ${contentHash}`;
    expect((cnt as { n: number }).n).toBe(1);
    const [row] = await admin`
      SELECT requested_by_user_id::text AS maker, status
        FROM forge.approval_requests WHERE subject_ref = ${contentHash}`;
    expect((row as { maker: string }).maker).toBe(maker); // server-recorded maker
    expect((row as { status: string }).status).toBe("pending");
  });
});
