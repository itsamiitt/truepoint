// forgeReviewTaskIdempotency.itest.ts — proves P-01.16 (verify half): a redelivered/retried verify job does NOT
// duplicate the human review task. The partial unique index (subject_ref, task_type) WHERE status='open' +
// ON CONFLICT DO NOTHING makes insertReviewTask converge, while a NEW task is still allowed once the prior one is
// resolved. Real Postgres (Testcontainers / ITEST_DATABASE_URL), own process; writes under withForgeTx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeReviewTaskIdempotency");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // applies through 0073 → the partial unique index
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("forge review-task idempotency (P-01.16)", () => {
  test("a redelivery does not duplicate the open task; a new task is allowed after resolution", async () => {
    const subject = crypto.randomUUID(); // subject_ref is plain text (no FK)
    const insert = () =>
      dbmod.withForgeTx((tx) =>
        dbmod.insertReviewTask(tx, {
          taskType: "ai_low_confidence",
          subjectRef: subject,
          confidence: 0.5,
          priority: 50,
        }),
      );

    await insert();
    await insert(); // the redelivery — ON CONFLICT DO NOTHING against the open task
    const [c1] = await admin`
      SELECT count(*)::int AS n FROM forge.review_tasks WHERE subject_ref = ${subject}`;
    expect((c1 as { n: number }).n).toBe(1); // exactly one, not two

    // resolve the open task, then a fresh verify legitimately creates a new open task (partial index).
    await admin`UPDATE forge.review_tasks SET status = 'resolved' WHERE subject_ref = ${subject}`;
    await insert();
    const [total] = await admin`
      SELECT count(*)::int AS n FROM forge.review_tasks WHERE subject_ref = ${subject}`;
    expect((total as { n: number }).n).toBe(2); // one resolved + one new open
    const [open] = await admin`
      SELECT count(*)::int AS n FROM forge.review_tasks WHERE subject_ref = ${subject} AND status = 'open'`;
    expect((open as { n: number }).n).toBe(1); // exactly one OPEN at any time
  });
});
