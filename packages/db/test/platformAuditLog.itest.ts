// platformAuditLog.itest.ts — the Phase 0b lockdown proof for platform_audit_log (the cross-tenant STAFF
// audit trail, ADR-0032) on a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL). Proves:
// (1) the owner/withPlatformTx path CAN append a row; (2) the customer app role leadwolf_app can NEITHER
// read NOR write it (REVOKE + RLS deny-all) — closing the gap where the blanket grant exposed the trail;
// (3) it is append-only — NO role (owner included) may UPDATE or DELETE. Named *.itest.ts so default
// `bun test` skips it; run in its own process: `bun test packages/db/test/platformAuditLog.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let owner: ReturnType<typeof postgres>; // the migration/owner connection — the withPlatformTx writer
let app: ReturnType<typeof postgres>; // the non-BYPASSRLS leadwolf_app role the customer API runs as

/** Run a rejecting call once and hand back the error for message assertions. */
async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("platformAuditLog");
  await applyMigrations(dbHandle.adminUrl);
  owner = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await owner?.end();
  await app?.end();
  await dbHandle?.stop();
});

describe("platform_audit_log lockdown (Phase 0b, ADR-0032)", () => {
  test("the owner/withPlatformTx path CAN append a row", async () => {
    const [row] = await owner`
      INSERT INTO platform_audit_log (actor_user_id, action)
      VALUES (gen_random_uuid(), 'tenant.read') RETURNING id`;
    expect((row as { id: string }).id).toBeTruthy();
  });

  test("leadwolf_app cannot READ the audit trail (REVOKE + RLS deny-all)", async () => {
    const err = await caught(() => app`SELECT id FROM platform_audit_log LIMIT 1`);
    expect(err.message).toMatch(/permission denied/i);
  });

  test("leadwolf_app cannot WRITE the audit trail", async () => {
    const err = await caught(
      () =>
        app`INSERT INTO platform_audit_log (actor_user_id, action) VALUES (gen_random_uuid(), 'forge')`,
    );
    expect(err.message).toMatch(/permission denied/i);
  });

  test("the audit trail is append-only — even the owner cannot UPDATE or DELETE", async () => {
    const upd = await caught(() => owner`UPDATE platform_audit_log SET action = 'tamper'`);
    expect(upd.message).toMatch(/append-only/i);
    const del = await caught(() => owner`DELETE FROM platform_audit_log`);
    expect(del.message).toMatch(/append-only/i);
  });
});
