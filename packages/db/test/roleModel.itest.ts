// roleModel.itest.ts — proves the Phase 1 role-model DB layer on a real Postgres (Testcontainers by default,
// or ITEST_DATABASE_URL): migration 0006 + rls/platform.sql apply cleanly, platform_staff is deny-all to
// leadwolf_app (REVOKE + RLS) while the owner reads/writes, and the org_role / staff_role CHECK constraints
// reject values outside the @leadwolf/types enums. Named *.itest.ts so default `bun test` skips it; run in
// its own process: `bun test packages/db/test/roleModel.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let owner: ReturnType<typeof postgres>; // migration/owner connection (requireStaffRole lookup + grants)
let app: ReturnType<typeof postgres>; // the non-BYPASSRLS leadwolf_app role the customer API runs as

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as Error;
  }
}

async function seedUser(email: string): Promise<string> {
  const [u] =
    await owner`INSERT INTO users (email, status) VALUES (${email}, 'active') RETURNING id`;
  return (u as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("roleModel");
  await applyMigrations(dbHandle.adminUrl);
  owner = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await owner?.end();
  await app?.end();
  await dbHandle?.stop();
});

describe("Phase 1 role model (ADR-0011/0030)", () => {
  test("leadwolf_app cannot read platform_staff (REVOKE + RLS deny-all)", async () => {
    const err = await caught(() => app`SELECT id FROM platform_staff LIMIT 1`);
    expect(err.message).toMatch(/permission denied/i);
  });

  test("the owner can grant a valid staff row", async () => {
    const userId = await seedUser("staff-grant@rm.test");
    const [row] = await owner`
      INSERT INTO platform_staff (user_id, staff_role) VALUES (${userId}, 'support') RETURNING id`;
    expect((row as { id: string }).id).toBeTruthy();
  });

  test("platform_staff.staff_role CHECK rejects a role outside the enum", async () => {
    const userId = await seedUser("staff-bad@rm.test");
    const err = await caught(
      () => owner`INSERT INTO platform_staff (user_id, staff_role) VALUES (${userId}, 'root')`,
    );
    expect(err.message).toMatch(/check|staff_role/i);
  });

  test("tenant_members.org_role defaults to member and the CHECK rejects an unknown role", async () => {
    const [t] =
      await owner`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme-rm') RETURNING id`;
    const tenantId = (t as { id: string }).id;
    const okUser = await seedUser("member-ok@rm.test");
    await owner`INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantId}, ${okUser})`;
    const [row] = await owner`
      SELECT org_role FROM tenant_members WHERE tenant_id = ${tenantId} AND user_id = ${okUser}`;
    expect((row as { org_role: string }).org_role).toBe("member");

    const badUser = await seedUser("member-bad@rm.test");
    const err = await caught(
      () =>
        owner`INSERT INTO tenant_members (tenant_id, user_id, org_role)
              VALUES (${tenantId}, ${badUser}, 'superuser')`,
    );
    expect(err.message).toMatch(/check|org_role/i);
  });
});
