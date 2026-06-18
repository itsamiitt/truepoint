// adminSessions.itest.ts — the G-AUTH-2 (admin session management) Definition-of-Done proof on a real
// Postgres 16 (10/14 §3.5): Testcontainers by default, or an external server via ITEST_DATABASE_URL (see
// itestDb.ts). Requires generated src/migrations (`bun run --filter @leadwolf/db generate`). Named *.itest.ts
// so default `bun test` skips it; run in its OWN process (the db client + config are module singletons):
// `bun test packages/db/test/adminSessions.itest.ts`.
//
// Proves the LIST + REVOKE SCOPING + AUTHORIZATION + AUDIT contract:
//   (1) a workspace admin lists ONLY the active sessions of members of THEIR workspace — a member's session
//       active in another workspace, and a cross-tenant session, are never returned, and the admin's own
//       current session is flagged `current`;
//   (2) revoking a member's session sets revoked_at + writes a `session.revoked` audit row in the SAME tx,
//       and the revoked session can no longer refresh (refreshAccessToken → invalid_token);
//   (3) a session that is NOT a member's in-scope session is a 404 (no cross-scope reach) and writes no audit;
//   (4) a NON-admin (member/viewer) caller is rejected (insufficient_role) and nothing is revoked/audited;
//   (5) force-reauth revokes ALL of a member's in-workspace sessions and audits the count.
// Composes the public @leadwolf/core admin-session functions over @leadwolf/auth session primitives and
// seeded membership rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Auth = typeof import("../../auth/src/index.ts");

const AUDIENCE = "https://app.test";

let dbHandle: ItestDb;
let core: Core;
let auth: Auth;
let admin: ReturnType<typeof postgres>;

// tenant1: ws-A (admin + member1 + viewer1) and ws-B (member1 also active here). tenant2: cross-tenant user.
let tenant1 = "";
let tenant2 = "";
let wsA = "";
let wsB = "";
let adminUser = ""; // owner|admin of ws-A
let member1 = ""; // member of ws-A AND ws-B
let viewer1 = ""; // viewer of ws-A (a non-admin caller)
let outsider = ""; // belongs to tenant2 only

async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

async function seedUser(email: string): Promise<string> {
  const [u] =
    await admin`INSERT INTO users (email, status) VALUES (${email}, 'active') RETURNING id`;
  return (u as { id: string }).id;
}
async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}
async function seedWorkspace(tenantId: string, slug: string): Promise<string> {
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, false, NULL) RETURNING id`;
  return (w as { id: string }).id;
}
async function addTenantMember(tenantId: string, userId: string): Promise<void> {
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, status) VALUES (${tenantId}, ${userId}, 'active')`;
}
async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: string,
): Promise<void> {
  await admin`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (${workspaceId}, ${userId}, ${role}, 'active', now())`;
}
async function sessionRow(sessionId: string): Promise<{ revoked_at: Date | null } | null> {
  const [s] = await admin`SELECT revoked_at FROM user_sessions WHERE id = ${sessionId}`;
  return (s as { revoked_at: Date | null }) ?? null;
}
async function auditCount(action: string): Promise<number> {
  const [r] = await admin`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("adminSessions");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.APP_ORIGINS = AUDIENCE;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  process.env.JWT_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.JWT_PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  tenant1 = await seedTenant("acme");
  tenant2 = await seedTenant("globex");
  wsA = await seedWorkspace(tenant1, "acme-sales");
  wsB = await seedWorkspace(tenant1, "acme-marketing");

  adminUser = await seedUser("admin@acme.test");
  member1 = await seedUser("member1@acme.test");
  viewer1 = await seedUser("viewer1@acme.test");
  outsider = await seedUser("outsider@globex.test");

  await addTenantMember(tenant1, adminUser);
  await addTenantMember(tenant1, member1);
  await addTenantMember(tenant1, viewer1);
  await addTenantMember(tenant2, outsider);

  await addWorkspaceMember(wsA, adminUser, "admin");
  await addWorkspaceMember(wsA, member1, "member");
  await addWorkspaceMember(wsA, viewer1, "viewer");
  await addWorkspaceMember(wsB, member1, "member"); // member1 is ALSO active in ws-B

  // env set above, BEFORE these dynamic imports load @leadwolf/config / the db singleton.
  core = await import("../../core/src/index.ts");
  auth = await import("../../auth/src/index.ts");
}, 240_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("G-AUTH-2 admin session management DoD", () => {
  test("list returns only ws-A member sessions; cross-workspace + cross-tenant excluded; current flagged", async () => {
    const adminSess = await auth.createSession({
      userId: adminUser,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
      ipAddress: "10.0.0.1",
      userAgent: "Chrome/itest",
    });
    await auth.createSession({
      userId: member1,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    // member1 also has a session active in ws-B — must NOT appear in the ws-A admin list.
    await auth.createSession({
      userId: member1,
      tenantId: tenant1,
      workspaceId: wsB,
      appOrigin: AUDIENCE,
    });
    // an outsider session in tenant2 — must never appear.
    await auth.createSession({
      userId: outsider,
      tenantId: tenant2,
      workspaceId: await seedWorkspace(tenant2, "globex-sales"),
      appOrigin: AUDIENCE,
    });

    const sessions = await core.listMemberSessions({
      tenantId: tenant1,
      workspaceId: wsA,
      actorUserId: adminUser,
      currentSessionId: adminSess.sessionId,
    });

    const userIds = new Set(sessions.map((s) => s.userId));
    expect(userIds.has(adminUser)).toBe(true);
    expect(userIds.has(member1)).toBe(true);
    expect(userIds.has(outsider)).toBe(false);
    // Exactly one member1 row (the ws-A one), not the ws-B one.
    expect(sessions.filter((s) => s.userId === member1)).toHaveLength(1);
    // The admin's own session is flagged current; no other row is.
    const adminRow = sessions.find((s) => s.id === adminSess.sessionId);
    expect(adminRow).toBeDefined();
    expect(adminRow?.current).toBe(true);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    // No refresh-token/secret fields leak into the view.
    expect(adminRow as unknown as Record<string, unknown>).not.toHaveProperty("refreshTokenHash");
  });

  test("revoke ends an in-scope session, audits session.revoked, and the session can no longer refresh", async () => {
    const before = await auditCount("session.revoked");
    const target = await auth.createSession({
      userId: member1,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });

    const result = await core.revokeMemberSession(
      { tenantId: tenant1, workspaceId: wsA, actorUserId: adminUser, currentSessionId: "x" },
      target.sessionId,
    );
    expect(result.revoked).toBe(1);
    expect((await sessionRow(target.sessionId))?.revoked_at).not.toBeNull();
    expect(await auditCount("session.revoked")).toBe(before + 1);

    // The revoked session's refresh token can no longer mint an access token.
    const err = await caught(() =>
      auth.refreshAccessToken({ presentedRefreshToken: target.refreshToken, audience: AUDIENCE }),
    );
    expect(err.code).toBe("invalid_token");
  });

  test("revoking a non-in-scope session id is 404 and writes no audit row", async () => {
    const before = await auditCount("session.revoked");
    // A session active only in ws-B is not in ws-A's scope.
    const wsBOnly = await auth.createSession({
      userId: member1,
      tenantId: tenant1,
      workspaceId: wsB,
      appOrigin: AUDIENCE,
    });
    const err = await caught(() =>
      core.revokeMemberSession(
        { tenantId: tenant1, workspaceId: wsA, actorUserId: adminUser },
        wsBOnly.sessionId,
      ),
    );
    expect(err.code).toBe("not_found");
    expect((await sessionRow(wsBOnly.sessionId))?.revoked_at).toBeNull(); // untouched
    expect(await auditCount("session.revoked")).toBe(before); // no audit on a no-op
  });

  test("a non-admin (viewer) caller is rejected and nothing is revoked/audited", async () => {
    const before = await auditCount("session.revoked");
    const target = await auth.createSession({
      userId: member1,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });

    const listErr = await caught(() =>
      core.listMemberSessions({ tenantId: tenant1, workspaceId: wsA, actorUserId: viewer1 }),
    );
    expect(listErr.code).toBe("insufficient_role");

    const revokeErr = await caught(() =>
      core.revokeMemberSession(
        { tenantId: tenant1, workspaceId: wsA, actorUserId: viewer1 },
        target.sessionId,
      ),
    );
    expect(revokeErr.code).toBe("insufficient_role");
    expect((await sessionRow(target.sessionId))?.revoked_at).toBeNull();
    expect(await auditCount("session.revoked")).toBe(before);
  });

  test("an outsider (non-member of the tenant) is rejected", async () => {
    const err = await caught(() =>
      core.listMemberSessions({ tenantId: tenant1, workspaceId: wsA, actorUserId: outsider }),
    );
    expect(err.code).toBe("insufficient_role");
  });

  test("force-reauth revokes ALL of a member's ws-A sessions and audits the count", async () => {
    const before = await auditCount("session.revoked");
    const s1 = await auth.createSession({
      userId: viewer1,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    const s2 = await auth.createSession({
      userId: viewer1,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });

    const result = await core.forceReauthMember(
      { tenantId: tenant1, workspaceId: wsA, actorUserId: adminUser },
      viewer1,
    );
    expect(result.revoked).toBeGreaterThanOrEqual(2);
    expect((await sessionRow(s1.sessionId))?.revoked_at).not.toBeNull();
    expect((await sessionRow(s2.sessionId))?.revoked_at).not.toBeNull();
    expect(await auditCount("session.revoked")).toBe(before + 1); // ONE audit row for the bulk action

    // Force-reauth on a non-member of the workspace is a 404.
    const err = await caught(() =>
      core.forceReauthMember(
        { tenantId: tenant1, workspaceId: wsA, actorUserId: adminUser },
        outsider,
      ),
    );
    expect(err.code).toBe("not_found");
  });
});
