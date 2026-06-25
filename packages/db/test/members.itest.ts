// members.itest.ts — the P1-03 (workspace members API) Definition-of-Done proof on a real Postgres 16
// (10/14 §3.5): Testcontainers by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts).
// Requires generated src/migrations (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default
// `bun test` skips it; run in its OWN process (the db client + config are module singletons):
// `bun test packages/db/test/members.itest.ts`.
//
// Proves the LIST + INVITE + ROLE + REMOVE + AUTHORIZATION + TENANT-ISOLATION + AUDIT contract:
//   (1) an admin lists ONLY their workspace's active members + pending invites (cross-workspace + cross-
//       tenant rows never appear);
//   (2) invite creates a pending invitation, is idempotent on (workspace, email) — re-invite refreshes the
//       same row, never duplicates — and writes a member.add audit row;
//   (3) change-role updates an active member and audits member.update; the workspace OWNER cannot be re-roled;
//   (4) remove soft-removes an active member (audits member.remove) and revokes a pending invite; the OWNER
//       can never be removed;
//   (5) a NON-admin (member/viewer) caller and a cross-tenant outsider are rejected (insufficient_role) and
//       nothing is written;
//   (6) cross-tenant isolation — an admin of tenant1/ws-A can never touch tenant2/ws-C's member or invite.
// Composes the public @leadwolf/core member functions over seeded membership + invitation rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

const AUDIENCE = "https://app.test";

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;

// tenant1: ws-A (owner + admin + member1 + viewer1) and ws-B (member1 also active). tenant2: ws-C (its own
// owner + member) — the cross-tenant isolation target.
let tenant1 = "";
let tenant2 = "";
let wsA = "";
let wsB = "";
let wsC = "";
let ownerUser = ""; // owner of ws-A
let adminUser = ""; // admin of ws-A (the acting caller)
let member1 = ""; // member of ws-A AND ws-B
let viewer1 = ""; // viewer of ws-A (a non-admin caller)
let outsider = ""; // owner of ws-C in tenant2

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
): Promise<string> {
  const [m] = await admin`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (${workspaceId}, ${userId}, ${role}, 'active', now()) RETURNING id`;
  return (m as { id: string }).id;
}
async function seedInvite(
  tenantId: string,
  workspaceId: string,
  email: string,
  role: string,
): Promise<string> {
  const [i] = await admin`
    INSERT INTO invitations (tenant_id, workspace_id, email, role, token_hash, expires_at)
    VALUES (${tenantId}, ${workspaceId}, ${email}, ${role}, ${`hash-${email}`}, now() + interval '7 days')
    RETURNING id`;
  return (i as { id: string }).id;
}
async function memberRow(
  memberId: string,
): Promise<{ role: string; status: string } | null> {
  const [m] = await admin`SELECT role, status FROM workspace_members WHERE id = ${memberId}`;
  return (m as { role: string; status: string }) ?? null;
}
async function inviteRows(workspaceId: string, email: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM invitations
    WHERE workspace_id = ${workspaceId} AND email = ${email} AND accepted_at IS NULL`;
  return (r as { n: number }).n;
}
async function auditCount(action: string): Promise<number> {
  const [r] = await admin`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("members");

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
  wsC = await seedWorkspace(tenant2, "globex-sales");

  ownerUser = await seedUser("owner@acme.test");
  adminUser = await seedUser("admin@acme.test");
  member1 = await seedUser("member1@acme.test");
  viewer1 = await seedUser("viewer1@acme.test");
  outsider = await seedUser("outsider@globex.test");

  await addTenantMember(tenant1, ownerUser);
  await addTenantMember(tenant1, adminUser);
  await addTenantMember(tenant1, member1);
  await addTenantMember(tenant1, viewer1);
  await addTenantMember(tenant2, outsider);

  await addWorkspaceMember(wsA, ownerUser, "owner");
  await addWorkspaceMember(wsA, adminUser, "admin");
  await addWorkspaceMember(wsA, member1, "member");
  await addWorkspaceMember(wsA, viewer1, "viewer");
  await addWorkspaceMember(wsB, member1, "member"); // member1 is ALSO active in ws-B
  await addWorkspaceMember(wsC, outsider, "owner"); // ws-C in tenant2

  // env set above, BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  core = await import("../../core/src/index.ts");
}, 240_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

// Built lazily (the ids are only populated in beforeAll, after module load).
const asAdmin = (): { tenantId: string; workspaceId: string; actorUserId: string } => ({
  tenantId: tenant1,
  workspaceId: wsA,
  actorUserId: adminUser,
});

describe("P1-03 workspace members management DoD", () => {
  test("list returns only ws-A active members + pending invites; cross-workspace/tenant excluded", async () => {
    await seedInvite(tenant1, wsA, "invitee@acme.test", "member");
    // A pending invite in ws-B (same tenant) and ws-C (other tenant) must NEVER appear in the ws-A list.
    await seedInvite(tenant1, wsB, "other-ws@acme.test", "member");
    await seedInvite(tenant2, wsC, "cross@globex.test", "member");

    const members = await core.listWorkspaceMembers({
      tenantId: tenant1,
      workspaceId: wsA,
      actorUserId: adminUser,
    });
    const emails = new Set(members.map((m) => m.email));
    // Active members of ws-A
    expect(emails.has("owner@acme.test")).toBe(true);
    expect(emails.has("admin@acme.test")).toBe(true);
    expect(emails.has("member1@acme.test")).toBe(true);
    expect(emails.has("viewer1@acme.test")).toBe(true);
    // The ws-A pending invite appears with status "invited"…
    const invited = members.find((m) => m.email === "invitee@acme.test");
    expect(invited?.status).toBe("invited");
    expect(invited?.userId).toBeNull();
    expect(invited?.joinedAt).toBeNull();
    // …and the owner is flagged with the owner role.
    expect(members.find((m) => m.email === "owner@acme.test")?.role).toBe("owner");
    // Cross-workspace + cross-tenant rows never leak in.
    expect(emails.has("other-ws@acme.test")).toBe(false);
    expect(emails.has("cross@globex.test")).toBe(false);
  });

  test("invite creates a pending invitation, is idempotent on (workspace,email), and audits member.add", async () => {
    const before = await auditCount("member.add");
    const r1 = await core.inviteMember(asAdmin(), { email: "New.Hire@acme.test", role: "member" });
    expect(r1.token.length).toBeGreaterThan(0);
    expect(await inviteRows(wsA, "new.hire@acme.test")).toBe(1); // normalized to lowercase, one row

    // Re-invite the SAME email → refreshes, never duplicates.
    const r2 = await core.inviteMember(asAdmin(), { email: "new.hire@acme.test", role: "admin" });
    expect(r2.id).toBe(r1.id);
    expect(r2.token).not.toBe(r1.token); // token rotated
    expect(await inviteRows(wsA, "new.hire@acme.test")).toBe(1); // still exactly one
    expect(await auditCount("member.add")).toBe(before + 2); // one per invite call
  });

  test("change-role updates an active member and audits member.update; owner is immutable", async () => {
    const before = await auditCount("member.update");
    // Find member1's ws-A membership id via the list.
    const members = await core.listWorkspaceMembers(asAdmin());
    const m = members.find((x) => x.email === "member1@acme.test");
    expect(m?.id).toBeDefined();

    const result = await core.changeMemberRole(asAdmin(), m!.id, "viewer");
    expect(result.updated).toBe(1);
    expect((await memberRow(m!.id))?.role).toBe("viewer");
    expect(await auditCount("member.update")).toBe(before + 1);

    // The workspace OWNER's role cannot be changed here.
    const owner = members.find((x) => x.email === "owner@acme.test");
    const err = await caught(() => core.changeMemberRole(asAdmin(), owner!.id, "admin"));
    expect(err.code).toBe("validation_error");
    expect((await memberRow(owner!.id))?.role).toBe("owner"); // untouched
  });

  test("remove soft-removes an active member (audits member.remove); owner can never be removed", async () => {
    const before = await auditCount("member.remove");
    const members = await core.listWorkspaceMembers(asAdmin());
    const viewerMember = members.find((x) => x.email === "viewer1@acme.test");

    const result = await core.removeMember(asAdmin(), viewerMember!.id);
    expect(result.removed).toBe(1);
    expect((await memberRow(viewerMember!.id))?.status).toBe("removed");
    expect(await auditCount("member.remove")).toBe(before + 1);

    // The OWNER can never be removed.
    const owner = members.find((x) => x.email === "owner@acme.test");
    const err = await caught(() => core.removeMember(asAdmin(), owner!.id));
    expect(err.code).toBe("validation_error");
    expect((await memberRow(owner!.id))?.status).toBe("active"); // untouched
  });

  test("remove also revokes a pending invite (by its id) and audits member.remove", async () => {
    const before = await auditCount("member.remove");
    const inviteId = await seedInvite(tenant1, wsA, "revoke-me@acme.test", "member");
    expect(await inviteRows(wsA, "revoke-me@acme.test")).toBe(1);

    const result = await core.removeMember(asAdmin(), inviteId);
    expect(result.removed).toBe(1);
    expect(await inviteRows(wsA, "revoke-me@acme.test")).toBe(0); // invite gone
    expect(await auditCount("member.remove")).toBe(before + 1);
  });

  test("a non-admin (viewer) caller and a cross-tenant outsider are rejected; nothing is written", async () => {
    const before = await auditCount("member.add");
    const viewerErr = await caught(() =>
      core.listWorkspaceMembers({ tenantId: tenant1, workspaceId: wsA, actorUserId: viewer1 }),
    );
    expect(viewerErr.code).toBe("insufficient_role");

    const memberErr = await caught(() =>
      core.inviteMember(
        { tenantId: tenant1, workspaceId: wsA, actorUserId: member1 },
        { email: "nope@acme.test", role: "member" },
      ),
    );
    expect(memberErr.code).toBe("insufficient_role");

    // outsider belongs to tenant2 — has no ws-A membership at all.
    const outErr = await caught(() =>
      core.listWorkspaceMembers({ tenantId: tenant1, workspaceId: wsA, actorUserId: outsider }),
    );
    expect(outErr.code).toBe("insufficient_role");
    expect(await auditCount("member.add")).toBe(before); // no write happened
  });

  test("cross-tenant isolation — ws-A admin can never touch a tenant2/ws-C member or invite", async () => {
    // ws-C's owner membership id (seeded in tenant2). The ws-A admin acting on it must NOT resolve it.
    const [wsCOwner] = await admin`
      SELECT id FROM workspace_members WHERE workspace_id = ${wsC} AND user_id = ${outsider}`;
    const wsCOwnerId = (wsCOwner as { id: string }).id;

    // Acting as the ws-A admin against the ws-A scope, a ws-C membership id is simply not found (RLS-scoped).
    const roleErr = await caught(() => core.changeMemberRole(asAdmin(), wsCOwnerId, "member"));
    expect(roleErr.code).toBe("not_found");
    const removeErr = await caught(() => core.removeMember(asAdmin(), wsCOwnerId));
    expect(removeErr.code).toBe("not_found");
    // The ws-C owner is untouched.
    expect((await memberRow(wsCOwnerId))?.role).toBe("owner");
    expect((await memberRow(wsCOwnerId))?.status).toBe("active");
  });
});
