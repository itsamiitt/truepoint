// forgeExtractionCandidates.itest.ts — proves P-01.2: the AI-extract stage output is PERSISTED (it was
// discarded). insertExtractionCandidates writes one row per (raw_capture_id, path) into
// forge.extraction_candidates and is idempotent — a re-extraction converges to the latest values, never
// duplicates. On a real Postgres (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts), own
// process. Writes run under withForgeTx (SET LOCAL ROLE leadwolf_forge), mirroring the extract worker.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeExtractionCandidates");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // applies through 0072 → creates forge.extraction_candidates
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

async function seedCapture(): Promise<string> {
  const [rc] = await admin`
    INSERT INTO forge.raw_captures
      (source, endpoint, schema_version, content_hash, target_tenant_id, payload_inline, byte_size)
    VALUES ('chrome_extension', 'voyager/identity/profiles', '1-0-0',
            ${`hash-${crypto.randomUUID()}`}, '00000000-0000-4000-8000-0000000000aa', '{}', 2)
    RETURNING id::text`;
  return (rc as { id: string }).id;
}

describe("forge extraction candidates persist (P-01.2)", () => {
  test("insert persists one row per path with confidence/band/grounded", async () => {
    const rawCaptureId = await seedCapture();
    const res = await dbmod.withForgeTx((tx) =>
      dbmod.insertExtractionCandidates(tx, [
        {
          rawCaptureId,
          path: "current_title",
          value: "VP Engineering",
          confidence: 0.91,
          band: "auto",
          grounded: true,
          extractSchemaVersion: "1-0-0",
        },
        {
          rawCaptureId,
          path: "current_company",
          value: "Acme",
          confidence: 0.62,
          band: "review",
          grounded: true,
        },
      ]),
    );
    expect(res.written).toBe(2);

    const rows = (await admin`
      SELECT path, value, confidence::text AS confidence, band, grounded
        FROM forge.extraction_candidates WHERE raw_capture_id = ${rawCaptureId} ORDER BY path`) as Array<{
      path: string;
      value: unknown;
      confidence: string;
      band: string;
      grounded: boolean;
    }>;
    expect(rows.length).toBe(2);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath.current_title.value).toBe("VP Engineering");
    expect(byPath.current_title.confidence).toBe("0.910");
    expect(byPath.current_title.band).toBe("auto");
    expect(byPath.current_title.grounded).toBe(true);
    expect(byPath.current_company.band).toBe("review");
  });

  test("re-extraction converges (idempotent on raw_capture_id, path) — updates, never duplicates", async () => {
    const rawCaptureId = await seedCapture();
    const write = (value: string, confidence: number, band: string) =>
      dbmod.withForgeTx((tx) =>
        dbmod.insertExtractionCandidates(tx, [
          { rawCaptureId, path: "current_title", value, confidence, band, grounded: true },
        ]),
      );
    await write("Engineer", 0.5, "review");
    await write("Senior Engineer", 0.88, "auto");

    const [row] = await admin`
      SELECT value, band FROM forge.extraction_candidates
        WHERE raw_capture_id = ${rawCaptureId} AND path = 'current_title'`;
    expect((row as { value: unknown; band: string }).value).toBe("Senior Engineer"); // converged to latest
    expect((row as { band: string }).band).toBe("auto");
    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM forge.extraction_candidates WHERE raw_capture_id = ${rawCaptureId}`;
    expect((cnt as { n: number }).n).toBe(1); // no duplicate
  });
});
