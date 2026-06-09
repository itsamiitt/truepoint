// seed.ts — wired to `bun run db:seed`. Seeds the GLOBAL-identity model (ADR-0019): two orgs each with an
// owner + default workspace, ONE shared identity that belongs to BOTH orgs (to exercise the org selector), a
// verified auto-join domain on Acme, and a pending invitation. Runs as the migration (superuser) role, which
// bypasses RLS. Idempotent: existing rows are skipped.

import { eq } from "drizzle-orm";
import { db } from "./client.ts";
import {
  invitations,
  tenantDomains,
  tenantMembers,
  tenants,
  tenantSsoConfigs,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/auth.ts";

const HOUR = 3_600_000;

async function ensureUser(email: string, fullName: string): Promise<string> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return existing[0].id;
  const [u] = await db
    .insert(users)
    .values({ email, fullName, emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  return u!.id;
}

interface Org {
  slug: string;
  name: string;
  wsName: string;
  wsSlug: string;
  ownerEmail: string;
}

const ORGS: Org[] = [
  { slug: "acme", name: "Acme Inc", wsName: "Acme Sales", wsSlug: "acme-sales", ownerEmail: "owner@acme.test" },
  { slug: "globex", name: "Globex Corp", wsName: "Globex Sales", wsSlug: "globex-sales", ownerEmail: "owner@globex.test" },
  { slug: "initech", name: "Initech", wsName: "Initech Sales", wsSlug: "initech-sales", ownerEmail: "owner@initech.test" },
];

async function ensureOrg(o: Org): Promise<{ tenantId: string; workspaceId: string }> {
  const existing = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, o.slug)).limit(1);
  if (existing[0]) {
    const ws = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.tenantId, existing[0].id))
      .limit(1);
    return { tenantId: existing[0].id, workspaceId: ws[0]?.id ?? "" };
  }
  const [t] = await db.insert(tenants).values({ name: o.name, slug: o.slug }).returning({ id: tenants.id });
  const ownerId = await ensureUser(o.ownerEmail, "Workspace Owner");
  await db.insert(tenantMembers).values({ tenantId: t!.id, userId: ownerId, isTenantOwner: true, status: "active" });
  const [ws] = await db
    .insert(workspaces)
    .values({ tenantId: t!.id, name: o.wsName, slug: o.wsSlug, isDefault: true, createdByUserId: ownerId })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: ws!.id, userId: ownerId, role: "owner", status: "active", joinedAt: new Date() });
  return { tenantId: t!.id, workspaceId: ws!.id };
}

async function main(): Promise<void> {
  const acme = await ensureOrg(ORGS[0]!);
  const globex = await ensureOrg(ORGS[1]!);
  const initech = await ensureOrg(ORGS[2]!);

  // A single global identity that belongs to BOTH orgs → exercises the org selector at login.
  const multiId = await ensureUser("multi@example.test", "Multi Org User");
  for (const [org, role] of [
    [acme, "admin"],
    [globex, "member"],
  ] as const) {
    await db
      .insert(tenantMembers)
      .values({ tenantId: org.tenantId, userId: multiId, status: "active" })
      .onConflictDoNothing();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: org.workspaceId, userId: multiId, role, status: "active", joinedAt: new Date() })
      .onConflictDoNothing();
  }

  // A verified auto-join domain on Acme + a pending invitation to Acme's workspace.
  await db
    .insert(tenantDomains)
    .values({ tenantId: acme.tenantId, domain: "acme.test", status: "verified", joinPolicy: "auto_join", verifiedAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(invitations)
    .values({
      tenantId: acme.tenantId,
      workspaceId: acme.workspaceId,
      email: "invitee@example.test",
      role: "member",
      tokenHash: "seed-invite-token-hash",
      expiresAt: new Date(Date.now() + 168 * HOUR),
    })
    .onConflictDoNothing();

  // Initech is an SSO-enforced org: its verified domain routes the identifier step to /sso, and the OIDC
  // config (provider 'mock' in dev) JIT-provisions first-time `@initech.test` sign-ins. (17 §7, ADR-0020.)
  await db
    .insert(tenantDomains)
    .values({ tenantId: initech.tenantId, domain: "initech.test", status: "verified", joinPolicy: "sso_only", verifiedAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(tenantSsoConfigs)
    .values({
      tenantId: initech.tenantId,
      protocol: "oidc",
      provider: "mock",
      jitEnabled: true,
      defaultRole: "member",
      enabled: true,
      enforced: true,
    })
    .onConflictDoNothing();

  console.log(`seed: acme=${acme.tenantId} globex=${globex.tenantId} initech=${initech.tenantId} multi=${multiId}`);
  console.log("seed: done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed: failed", err);
  process.exit(1);
});
