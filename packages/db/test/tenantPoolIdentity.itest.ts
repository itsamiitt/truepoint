// tenantPoolIdentity.itest.ts — proves withTenantTx runs on a leadwolf_app LOGIN connection (E-6.3).
//
// This test exists because the change it guards is SILENTLY INERT when it fails. The app connection URL is
// derived from DATABASE_URL by swapping in the app role's credentials, and it falls back to the owner
// connection when no app-role password is configured. That fallback is deliberate — it keeps unconfigured
// deployments working — but it means a broken derivation looks exactly like a working one: every other test
// still passes, because the owner can do everything leadwolf_app can and more.
//
// So the assertion here is on SESSION_USER, not current_user. current_user reflects `SET ROLE`, which
// withTenantTx has always issued and which passes even on an owner connection; session_user is the role that
// actually AUTHENTICATED, and it is the only thing that distinguishes "RLS enforced by the connection" from
// "RLS enforced by a statement that happened to run".

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let dbmod: typeof import("@leadwolf/db");
let tenantId = "";
let workspaceId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("tenant-pool-identity");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  const postgres = (await import("postgres")).default;
  const admin = postgres(dbHandle.adminUrl, { max: 1, onnotice: () => {} });
  const [t] =
    await admin`INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme','acme',0) RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('pool@acme.test') RETURNING id`;
  const ownerId = (u as { id: string }).id;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${ownerId}) RETURNING id`;
  workspaceId = (w as { id: string }).id;
  await admin.end({ timeout: 5 });

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await dbHandle?.stop();
});

test("withTenantTx AUTHENTICATES as leadwolf_app, not merely SET ROLEs to it", async () => {
  const identity = await dbmod.withTenantTx({ tenantId, workspaceId }, async (tx) => {
    const rows = (await tx.execute(
      // session_user = the role that logged in; current_user = the role after SET ROLE.
      `SELECT session_user::text AS session_user, current_user::text AS current_user`,
    )) as unknown as Array<{ session_user: string; current_user: string }>;
    return rows[0];
  });

  // The point of the change: the CONNECTION is non-BYPASSRLS, so an unscoped read fails closed even if the
  // role statement inside the transaction never ran. If this reads the owner, the derivation silently fell
  // back and the hardening is not in effect — which no other test would notice.
  expect(identity?.session_user).toBe("leadwolf_app");
  // current_user was already leadwolf_app before this change; asserted so a regression that drops the SET
  // ROLE is still caught.
  expect(identity?.current_user).toBe("leadwolf_app");
});

test("the privileged paths still authenticate as the OWNER — they need roles app is not a member of", async () => {
  // withPrivilegedTx/withErTx/withForgeTx SET LOCAL ROLE to leadwolf_admin / leadwolf_er / leadwolf_forge.
  // leadwolf_app is deliberately not a member of any of them, so moving these to the app pool would break
  // them outright. This pins that they stayed put.
  const sessionUser = await dbmod.withPrivilegedTx(async (tx) => {
    const rows = (await tx.execute(
      `SELECT session_user::text AS session_user`,
    )) as unknown as Array<{ session_user: string }>;
    return rows[0]?.session_user;
  });
  expect(sessionUser).not.toBe("leadwolf_app");
});
