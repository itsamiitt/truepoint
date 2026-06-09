// seed.ts — wired to `bun run db:seed`. Creates two tenants (each: an owner user + a default workspace +
// owner membership) so cross-workspace isolation + dedup demos have data to work with (14 §2). Idempotent:
// re-running skips tenants that already exist and just re-prints their ids. Runs as the migration role.

import { eq } from "drizzle-orm";
import { db } from "./client.ts";
import { tenants, users, workspaceMembers, workspaces } from "./schema/auth.ts";

interface Fixture {
  tenantSlug: string;
  tenantName: string;
  ownerEmail: string;
  workspaceName: string;
  workspaceSlug: string;
}

const FIXTURES: Fixture[] = [
  {
    tenantSlug: "acme",
    tenantName: "Acme Inc",
    ownerEmail: "owner@acme.test",
    workspaceName: "Acme Sales",
    workspaceSlug: "acme-sales",
  },
  {
    tenantSlug: "globex",
    tenantName: "Globex Corp",
    ownerEmail: "owner@globex.test",
    workspaceName: "Globex Sales",
    workspaceSlug: "globex-sales",
  },
];

async function seedOne(f: Fixture): Promise<{ tenantId: string; workspaceId: string; ownerUserId: string }> {
  const existing = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, f.tenantSlug)).limit(1);
  if (existing[0]) {
    const ws = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.tenantId, existing[0].id))
      .limit(1);
    const owner = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, existing[0].id)).limit(1);
    return { tenantId: existing[0].id, workspaceId: ws[0]?.id ?? "", ownerUserId: owner[0]?.id ?? "" };
  }

  const [tenant] = await db
    .insert(tenants)
    .values({ name: f.tenantName, slug: f.tenantSlug })
    .returning({ id: tenants.id });
  const [owner] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: f.ownerEmail, fullName: "Workspace Owner", isTenantOwner: true })
    .returning({ id: users.id });
  const [ws] = await db
    .insert(workspaces)
    .values({ tenantId: tenant!.id, name: f.workspaceName, slug: f.workspaceSlug, isDefault: true, createdByUserId: owner!.id })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: ws!.id, userId: owner!.id, role: "owner", status: "active", joinedAt: new Date() });

  return { tenantId: tenant!.id, workspaceId: ws!.id, ownerUserId: owner!.id };
}

async function main(): Promise<void> {
  for (const f of FIXTURES) {
    const r = await seedOne(f);
    console.log(`seed: ${f.tenantSlug} → tenant=${r.tenantId} workspace=${r.workspaceId} owner=${r.ownerUserId}`);
  }
  console.log("seed: done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed: failed", err);
  process.exit(1);
});
