// bootstrapAdmin.ts — provision the platform Bootstrap Admin (super-admin, ADR-0032): an immediately-
// loginable identity (verified + active + is_platform_admin, no MFA) with a home "TruePoint" org +
// workspace (finalizeLogin requires a tenant membership). Runs as the migration/owner role (bypasses RLS),
// like seed.ts. The Argon2id hash is computed by the auth layer and passed in (this package must not depend
// on @leadwolf/auth). Idempotent — safe to re-run; self-heals the is_platform_admin + is_bootstrap_admin
// columns. Keyed off the is_bootstrap_admin marker (not email), so deploy.sh re-runs it every deploy to make
// .env the source of truth: a changed password is re-hashed, a changed email renames the SAME record (ADR-0034).
import { eq, sql } from "drizzle-orm";
import { db } from "./client.ts";
import {
  platformStaff,
  tenantMembers,
  tenants,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/auth.ts";

export interface BootstrapAdminInput {
  email: string;
  passwordHash: string;
  fullName: string;
}

export interface BootstrapAdminResult {
  userId: string;
  tenantId: string;
  workspaceId: string;
}

export async function provisionBootstrapAdmin(
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  // Self-heal: ensure the column + the platform audit table exist even where the schema migration hasn't
  // (re)run on this DB. platform_audit_log is platform-scoped (NOT workspace-RLS); only the owner /
  // withPlatformTx writes it. Its authoritative lockdown — RLS deny-all to leadwolf_app + append-only
  // trigger + REVOKE of the blanket grant — lives in rls/platform.sql + applyMigrations (ADR-0032); this
  // CREATE IF NOT EXISTS is only a redundant self-heal with identical columns.
  await db.execute(
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false`,
  );
  // The stable bootstrap marker (migration 0009). Self-heal it the same way so provisioning works even on a
  // DB where 0009 hasn't (re)run yet — this is what lets an email rotation rename the same record.
  await db.execute(
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bootstrap_admin boolean NOT NULL DEFAULT false`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_audit_log (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      actor_user_id uuid NOT NULL,
      action text NOT NULL,
      target_type text,
      target_id text,
      tenant_id uuid,
      workspace_id uuid,
      ip text,
      metadata jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Resolve THE bootstrap identity by its stable marker FIRST (not by email), so rotating
  // BOOTSTRAP_ADMIN_EMAIL renames the same record instead of creating a second super-admin and orphaning the
  // old one (which would keep its credential + platform access). Fall back to the email (adopts a record from
  // an older bootstrap that predates the marker), else insert. Always verified + active + platform-admin, no
  // MFA → immediate login; the password hash is (re)written on every run so `.env` is the source of truth.
  const byMarker = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.isBootstrapAdmin, true))
    .limit(1);
  const byEmail = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  let userId: string;
  if (byMarker[0]) {
    userId = byMarker[0].id;
    // Renaming to a new email: refuse if that address already belongs to a DIFFERENT account. The
    // global-unique email constraint would reject the UPDATE anyway — fail with a clear, actionable message
    // instead of a raw Postgres unique-violation.
    if (
      byMarker[0].email.toLowerCase() !== input.email.toLowerCase() &&
      byEmail[0] &&
      byEmail[0].id !== userId
    ) {
      throw new Error(
        "bootstrapAdmin: BOOTSTRAP_ADMIN_EMAIL is already used by another account — choose a free address.",
      );
    }
    await db
      .update(users)
      .set({
        email: input.email,
        passwordHash: input.passwordHash,
        fullName: input.fullName,
        emailVerifiedAt: new Date(),
        status: "active",
        isPlatformAdmin: true,
        isBootstrapAdmin: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } else if (byEmail[0]) {
    // Adopt the existing same-email identity as the bootstrap admin (created by an older bootstrap or by hand).
    userId = byEmail[0].id;
    await db
      .update(users)
      .set({
        passwordHash: input.passwordHash,
        fullName: input.fullName,
        emailVerifiedAt: new Date(),
        status: "active",
        isPlatformAdmin: true,
        isBootstrapAdmin: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } else {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email,
        fullName: input.fullName,
        passwordHash: input.passwordHash,
        authProvider: "password",
        emailVerifiedAt: new Date(),
        status: "active",
        isPlatformAdmin: true,
        isBootstrapAdmin: true,
      })
      .returning({ id: users.id });
    userId = row!.id;
  }

  // Home org + default workspace.
  const existingTenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, "truepoint"))
    .limit(1);
  const tenantId = existingTenant[0]
    ? existingTenant[0].id
    : (
        await db
          .insert(tenants)
          .values({ name: "TruePoint", slug: "truepoint" })
          .returning({ id: tenants.id })
      )[0]!.id;

  const existingWs = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.tenantId, tenantId))
    .limit(1);
  const workspaceId = existingWs[0]
    ? existingWs[0].id
    : (
        await db
          .insert(workspaces)
          .values({
            tenantId,
            name: "TruePoint HQ",
            slug: "truepoint-hq",
            isDefault: true,
            createdByUserId: userId,
          })
          .returning({ id: workspaces.id })
      )[0]!.id;

  // Owner memberships (idempotent on the unique (tenant,user) / (workspace,user) keys). org_role='owner' is
  // set EXPLICITLY here: the migrate-time backfill (rls/platform.sql) keys off is_tenant_owner and ran before
  // this user existed, so without this the Auth Admin (requireOrgRole) would not recognise the bootstrap
  // admin as org owner.
  await db
    .insert(tenantMembers)
    .values({ tenantId, userId, isTenantOwner: true, orgRole: "owner", status: "active" })
    .onConflictDoUpdate({
      target: [tenantMembers.tenantId, tenantMembers.userId],
      set: { isTenantOwner: true, orgRole: "owner", status: "active" },
    });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() })
    .onConflictDoNothing();

  // Platform STAFF super_admin (ADR-0011): same ordering problem — the migrate-time platform_staff backfill
  // keys off is_platform_admin and ran before this user existed. Grant it here, or requireStaffRole would
  // 403 the bootstrap admin on the staff-console RBAC surfaces (Staff / Providers / Audit log).
  await db
    .insert(platformStaff)
    .values({ userId, staffRole: "super_admin", status: "active" })
    .onConflictDoUpdate({
      target: platformStaff.userId,
      set: { staffRole: "super_admin", status: "active", revokedAt: null },
    });

  return { userId, tenantId, workspaceId };
}
