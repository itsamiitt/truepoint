// bootstrapAdmin.itest.ts — proves the platform Bootstrap Admin provisioning (ADR-0034) against real Postgres
// (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). This is the permanent fix for "changed
// .env credentials but the bootstrap admin can't log in": provisioning is repeatable and keyed off the stable
// is_bootstrap_admin marker, so it
//   1. CREATES the super-admin (verified + active + is_platform_admin + is_bootstrap_admin) with owner
//      memberships + platform_staff super_admin on first run;
//   2. RE-WRITES the Argon2id password hash on every re-run (a changed BOOTSTRAP_ADMIN_PASSWORD takes effect);
//   3. RENAMES the SAME record when the email changes (no orphaned second super-admin);
//   4. FAILS CLOSED when the new email is already owned by a different account.
// Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/bootstrapAdmin.itest.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
  is_platform_admin: boolean;
  is_bootstrap_admin: boolean;
}

const userById = async (id: string): Promise<UserRow> => {
  const [row] = await admin`SELECT * FROM users WHERE id = ${id}`;
  return row as unknown as UserRow;
};

beforeAll(async () => {
  dbHandle = await startItestDb("bootstrap-admin");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await dbHandle?.stop();
});

test("first run creates the super-admin with the marker, memberships, and staff role", async () => {
  const res = await db.provisionBootstrapAdmin({
    email: "boot@truepoint.test",
    passwordHash: "hash-v1",
    fullName: "Bootstrap Admin",
  });

  const u = await userById(res.userId);
  expect(u.email).toBe("boot@truepoint.test");
  expect(u.password_hash).toBe("hash-v1");
  expect(u.status).toBe("active");
  expect(u.email_verified_at).not.toBeNull();
  expect(u.is_platform_admin).toBe(true);
  expect(u.is_bootstrap_admin).toBe(true);

  // Owner memberships + platform staff super_admin so requireOrgRole / requireStaffRole recognise it.
  const [tm] = await admin`
    SELECT org_role, is_tenant_owner FROM tenant_members WHERE user_id = ${res.userId}`;
  expect((tm as { org_role: string }).org_role).toBe("owner");
  const [ps] = await admin`
    SELECT staff_role, status FROM platform_staff WHERE user_id = ${res.userId}`;
  expect((ps as { staff_role: string; status: string }).staff_role).toBe("super_admin");
  expect((ps as { status: string }).status).toBe("active");
});

test("re-running with a new password hash updates the SAME record (.env is source of truth)", async () => {
  const first = await admin`SELECT id FROM users WHERE is_bootstrap_admin = true`;
  const res = await db.provisionBootstrapAdmin({
    email: "boot@truepoint.test",
    passwordHash: "hash-v2",
    fullName: "Bootstrap Admin",
  });
  // Same identity, new hash — no duplicate admin.
  expect(res.userId).toBe((first[0] as { id: string }).id);
  expect((await userById(res.userId)).password_hash).toBe("hash-v2");
  const count = await admin`SELECT count(*)::int AS n FROM users WHERE is_bootstrap_admin = true`;
  expect((count[0] as { n: number }).n).toBe(1);
});

test("changing the email RENAMES the same record (no orphaned second super-admin)", async () => {
  const before = await admin`SELECT id FROM users WHERE is_bootstrap_admin = true`;
  const res = await db.provisionBootstrapAdmin({
    email: "newboot@truepoint.test",
    passwordHash: "hash-v3",
    fullName: "Bootstrap Admin",
  });
  expect(res.userId).toBe((before[0] as { id: string }).id);
  expect((await userById(res.userId)).email).toBe("newboot@truepoint.test");
  // Still exactly one bootstrap admin; the old email no longer resolves to a platform admin.
  const count = await admin`SELECT count(*)::int AS n FROM users WHERE is_bootstrap_admin = true`;
  expect((count[0] as { n: number }).n).toBe(1);
  const old = await admin`SELECT id FROM users WHERE email = 'boot@truepoint.test'`;
  expect(old.length).toBe(0);
});

test("renaming onto an address owned by a different account fails closed", async () => {
  await admin`INSERT INTO users (email) VALUES ('someone-else@truepoint.test')`;
  await expect(
    db.provisionBootstrapAdmin({
      email: "someone-else@truepoint.test",
      passwordHash: "hash-v4",
      fullName: "Bootstrap Admin",
    }),
  ).rejects.toThrow(/already used by another account/);
});
