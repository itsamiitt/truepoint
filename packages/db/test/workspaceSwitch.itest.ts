// workspaceSwitch.itest.ts — the ADR-0019 workspace-switch + session-lifecycle Definition-of-Done proof on
// a real Postgres 16 (10/14 §3.5): Testcontainers by default, or an external server via ITEST_DATABASE_URL
// (see itestDb.ts). Requires generated src/migrations (`bun run --filter @leadwolf/db generate`). Named
// *.itest.ts so default `bun test` skips it; run in its OWN process (the db client + config are module
// singletons): `bun test packages/db/test/workspaceSwitch.itest.ts`.
//
// Proves: (1) a user who belongs to workspaces A+B in ONE tenant switching A→B re-pins the session row to B,
// revokes the old session (rotation), and the freshly minted access token carries wid=B; (2) switching to a
// workspace the user is NOT an active member of (same tenant) is rejected (workspace_forbidden) and the
// session is unchanged; (3) switching to a workspace in ANOTHER tenant is rejected the same way (no
// cross-tenant escalation); (4) a revoked session and an expired session are both rejected (invalid_token);
// (5) after logout (revokeSession), the old refresh cookie can no longer be refreshed. Composes the public
// @leadwolf/auth primitives (createSession/switchWorkspace/refreshAccessToken/revokeSession) over seeded
// membership rows; the access token's wid is read by decoding the JWT payload (no remote JWKS needed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Auth = typeof import("@leadwolf/auth");

let dbHandle: ItestDb;
let auth: Auth;
let admin: ReturnType<typeof postgres>;

const AUDIENCE = "https://app.test";

// One tenant with TWO workspaces (the switch happens within it); a SECOND tenant for the cross-tenant guard.
let tenant1 = "";
let tenant2 = "";
let wsA = ""; // tenant1, alice is a member
let wsB = ""; // tenant1, alice is a member (the switch target)
let wsNoMember = ""; // tenant1, alice is NOT a member
let wsCrossTenant = ""; // tenant2, alice is NOT a member (and it is another tenant entirely)
let alice = "";

/** Decode a JWT's payload segment without verifying — we only assert the claims the mint put there. */
function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1]!;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Run a rejecting call once and hand back the error (typed loosely for code/message assertions). */
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

async function sessionRow(
  sessionId: string,
): Promise<{ workspace_id: string | null; revoked_at: Date | null } | null> {
  const [s] = await admin`
    SELECT workspace_id, revoked_at FROM user_sessions WHERE id = ${sessionId}`;
  return (s as { workspace_id: string | null; revoked_at: Date | null }) ?? null;
}

beforeAll(async () => {
  dbHandle = await startItestDb("workspaceSwitch");

  // Set the runtime env BEFORE the first @leadwolf/config import (it freezes env at load). The test preload
  // (test/setup.ts) seeds the rest; here we add the EdDSA signing keys the token mint needs (the preload
  // leaves the PEMs empty), plus the test DB + blind-index key, exactly like the other itests.
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
  wsNoMember = await seedWorkspace(tenant1, "acme-finance");
  wsCrossTenant = await seedWorkspace(tenant2, "globex-sales");

  alice = await seedUser("alice@acme.test");
  await addTenantMember(tenant1, alice); // alice belongs to tenant1
  await addWorkspaceMember(wsA, alice, "admin"); // …and to WS-A
  await addWorkspaceMember(wsB, alice, "member"); // …and WS-B (the switch target)
  // alice is deliberately NOT a member of wsNoMember (same tenant) nor wsCrossTenant (other tenant).

  // env is set above, BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  auth = await import("@leadwolf/auth");
}, 240_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("ADR-0019 workspace switch & session lifecycle DoD", () => {
  test("A→B re-pins the session, revokes the old one, and the new token carries wid=B", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    expect((await sessionRow(session.sessionId))?.workspace_id).toBe(wsA);

    const result = await auth.switchWorkspace({
      presentedRefreshToken: session.refreshToken,
      targetWorkspaceId: wsB,
      audience: AUDIENCE,
    });

    // The freshly minted access token carries the NEW workspace + the same tenant.
    const claims = decodeClaims(result.accessToken);
    expect(claims.wid).toBe(wsB);
    expect(claims.tid).toBe(tenant1);
    expect(claims.sub).toBe(alice);
    expect(result.refreshToken).not.toBe(session.refreshToken); // rotation issued a fresh token

    // The OLD session is revoked (rotation reuse-detection); a brand-new session is pinned to WS-B.
    expect((await sessionRow(session.sessionId))?.revoked_at).not.toBeNull();
    const [pinned] = await admin`
      SELECT workspace_id FROM user_sessions
      WHERE refresh_token_hash = ${auth.hashRefreshToken(result.refreshToken)}`;
    expect((pinned as { workspace_id: string }).workspace_id).toBe(wsB);
  });

  test("switching to a non-member workspace in the same tenant is rejected; session unchanged", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });

    const err = await caught(() =>
      auth.switchWorkspace({
        presentedRefreshToken: session.refreshToken,
        targetWorkspaceId: wsNoMember,
        audience: AUDIENCE,
      }),
    );
    expect(err.code).toBe("workspace_forbidden");

    // The session is untouched — still pinned to WS-A and NOT revoked (the AUTHZ check precedes any mutation).
    const row = await sessionRow(session.sessionId);
    expect(row?.workspace_id).toBe(wsA);
    expect(row?.revoked_at).toBeNull();
  });

  test("switching to a workspace in ANOTHER tenant is rejected (no cross-tenant escalation)", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });

    const err = await caught(() =>
      auth.switchWorkspace({
        presentedRefreshToken: session.refreshToken,
        targetWorkspaceId: wsCrossTenant, // belongs to tenant2 — alice's tenant1 session must not reach it
        audience: AUDIENCE,
      }),
    );
    expect(err.code).toBe("workspace_forbidden");

    const row = await sessionRow(session.sessionId);
    expect(row?.workspace_id).toBe(wsA);
    expect(row?.revoked_at).toBeNull();
  });

  test("a revoked session is rejected (invalid_token)", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    await auth.revokeSession(session.sessionId);

    const err = await caught(() =>
      auth.switchWorkspace({
        presentedRefreshToken: session.refreshToken,
        targetWorkspaceId: wsB,
        audience: AUDIENCE,
      }),
    );
    expect(err.code).toBe("invalid_token");
  });

  test("an expired session is rejected (invalid_token)", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    // Backdate the expiry past now — the switch primitive checks expiresAt before any work.
    await admin`
      UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${session.sessionId}`;

    const err = await caught(() =>
      auth.switchWorkspace({
        presentedRefreshToken: session.refreshToken,
        targetWorkspaceId: wsB,
        audience: AUDIENCE,
      }),
    );
    expect(err.code).toBe("invalid_token");
  });

  test("after logout (revokeSession) the old refresh cookie can no longer be refreshed", async () => {
    const session = await auth.createSession({
      userId: alice,
      tenantId: tenant1,
      workspaceId: wsA,
      appOrigin: AUDIENCE,
    });
    // The cookie still refreshes while the session is live…
    const refreshed = await auth.refreshAccessToken({
      presentedRefreshToken: session.refreshToken,
      audience: AUDIENCE,
    });
    expect(decodeClaims(refreshed.accessToken).wid).toBe(wsA);

    // …refresh rotated the token, so the ORIGINAL cookie is already a revoked (reuse) token.
    const reuse = await caught(() =>
      auth.refreshAccessToken({ presentedRefreshToken: session.refreshToken, audience: AUDIENCE }),
    );
    expect(reuse.code).toBe("invalid_token");

    // Logout revokes the CURRENT session; its refresh token then fails too.
    const [current] = await admin`
      SELECT id FROM user_sessions
      WHERE refresh_token_hash = ${auth.hashRefreshToken(refreshed.refreshToken)}`;
    await auth.revokeSession((current as { id: string }).id);
    const afterLogout = await caught(() =>
      auth.refreshAccessToken({
        presentedRefreshToken: refreshed.refreshToken,
        audience: AUDIENCE,
      }),
    );
    expect(afterLogout.code).toBe("invalid_token");
  });
});
