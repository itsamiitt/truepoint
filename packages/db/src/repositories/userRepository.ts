// userRepository.ts — data access for the user/identity aggregate (auth domain): `users` and their
// `user_sessions`. Sessions are co-located here because they belong to the user aggregate (one boundary,
// one domain → auth). Returns typed domain records, never raw rows; the raw refresh token never touches
// the DB (only its hash). findByEmail is the pre-tenant identifier lookup under the auth-service role (17 §1).

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import {
  authEmailTokens,
  userMfaMethods,
  userSessions,
  users,
  workspaceMembers,
} from "../schema/auth.ts";

// ── Users (global identity — ADR-0019; org membership is in tenantMemberRepository) ──────────────────────
export interface UserRecord {
  id: string;
  email: string;
  username: string | null;
  fullName: string | null;
  passwordHash: string | null;
  authProvider: string;
  emailVerifiedAt: Date | null;
  status: string;
  isPlatformAdmin: boolean;
}

type UserRow = typeof users.$inferSelect;
const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  username: r.username,
  fullName: r.fullName,
  passwordHash: r.passwordHash,
  authProvider: r.authProvider,
  emailVerifiedAt: r.emailVerifiedAt,
  status: r.status,
  isPlatformAdmin: r.isPlatformAdmin,
});

export const userRepository = {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const row = rows[0];
    return row ? toUser(row) : null;
  },

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? toUser(row) : null;
  },

  // Identifier-first lookup: an email OR the optional username alias resolves to one global identity (ADR-0020).
  async findByEmailOrUsername(identifier: string): Promise<UserRecord | null> {
    const rows = await db
      .select()
      .from(users)
      .where(or(eq(users.email, identifier), eq(users.username, identifier)))
      .limit(1);
    const row = rows[0];
    return row ? toUser(row) : null;
  },

  async usernameExists(username: string): Promise<boolean> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows.length > 0;
  },

  // Create a global identity at registration (ADR-0020). email_verified_at is set because /signup proves
  // the email before this runs; the unique(email)/unique(username) constraints are the race backstop.
  async create(input: {
    email: string;
    fullName: string;
    username?: string;
    passwordHash?: string;
    authProvider?: string;
    emailVerifiedAt?: Date;
  }): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email,
        fullName: input.fullName,
        username: input.username,
        passwordHash: input.passwordHash,
        authProvider: input.authProvider ?? "password",
        emailVerifiedAt: input.emailVerifiedAt ?? null,
        status: input.emailVerifiedAt ? "active" : "pending",
      })
      .returning({ id: users.id });
    return row!.id;
  },

  async markEmailVerified(id: string): Promise<void> {
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date(), status: "active", updatedAt: new Date() })
      .where(eq(users.id, id));
  },

  async touchLastLogin(id: string): Promise<void> {
    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  },

  // Replace the user's Argon2id digest (password reset — packages/auth/passwordReset). The hash is opaque
  // and pre-computed by the auth layer; it is never logged or returned. findByEmail runs under the
  // auth-service role (pre-tenant identity), so this mutation stays in the same auth-domain boundary.
  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  },

  async listMfaMethods(userId: string): Promise<MfaMethodRecord[]> {
    const rows = await db
      .select({
        type: userMfaMethods.type,
        secretEnc: userMfaMethods.secretEnc,
        verifiedAt: userMfaMethods.verifiedAt,
      })
      .from(userMfaMethods)
      .where(eq(userMfaMethods.userId, userId));
    return rows.map((r) => ({ type: r.type, secretEnc: r.secretEnc, verifiedAt: r.verifiedAt }));
  },
};

export interface MfaMethodRecord {
  type: string;
  secretEnc: Uint8Array | null;
  verifiedAt: Date | null;
}

// ── Sessions (part of the user aggregate) ────────────────────────────────────────────────────────────
export interface SessionRecord {
  id: string;
  userId: string;
  tenantId: string | null;
  workspaceId: string | null;
  deviceId: string | null;
  appOrigin: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  tenantId?: string;
  workspaceId?: string;
  appOrigin?: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

type SessionRow = typeof userSessions.$inferSelect;
const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userId: r.userId,
  tenantId: r.tenantId,
  workspaceId: r.workspaceId,
  deviceId: r.deviceId,
  appOrigin: r.appOrigin,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
});

export const sessionRepository = {
  async create(input: CreateSessionInput): Promise<void> {
    await db.insert(userSessions).values({ ...input, lastSeenAt: new Date() });
  },

  async findActiveById(id: string): Promise<SessionRecord | null> {
    const rows = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.id, id), isNull(userSessions.revokedAt)))
      .limit(1);
    const row = rows[0];
    return row ? toSession(row) : null;
  },

  async findByRefreshTokenHash(hash: string): Promise<SessionRecord | null> {
    const rows = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.refreshTokenHash, hash))
      .limit(1);
    const row = rows[0];
    return row ? toSession(row) : null;
  },

  async revoke(id: string): Promise<void> {
    await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, id));
  },

  // Pin the session's active workspace (chosen at the workspace-selection step; ADR-0019). Durable on the
  // auth origin, so it runs on the global client like the rest of the session aggregate.
  async setWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    await db.update(userSessions).set({ workspaceId }).where(eq(userSessions.id, sessionId));
  },

  async rotate(args: { oldId: string; next: CreateSessionInput }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(eq(userSessions.id, args.oldId));
      await tx
        .insert(userSessions)
        .values({ ...args.next, rotatedFrom: args.oldId, lastSeenAt: new Date() });
    });
  },

  async listForUser(userId: string): Promise<SessionRecord[]> {
    const rows = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .orderBy(desc(userSessions.createdAt));
    return rows.map(toSession);
  },

  // ── Workspace-admin session management (G-AUTH-2, 17 §5/§10) ───────────────────────────────────────
  // `user_sessions` is auth-service-owned and has NO tenant RLS policy (rls/auth.sql). So these admin reads
  // MUST scope themselves explicitly: every method joins the session to `workspace_members` (which IS
  // RLS-isolated to the GUC tenant under withTenantTx) and filters by the target workspace — the join is the
  // tenant/workspace boundary. We additionally pin user_sessions.workspace_id to the same workspace so a
  // member's sessions that are active in a DIFFERENT workspace are not exposed here. Active = not revoked and
  // not expired. These do NOT touch session creation/rotation/validation.

  /**
   * Active sessions for the members of `scope.workspaceId`, newest first (admin sessions table). RLS-scoped:
   * the workspace_members join only sees rows for the GUC tenant, so a foreign workspaceId yields nothing.
   */
  async listForWorkspace(scope: Required<TenantScope>, limit = 200): Promise<AdminSessionRecord[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: userSessions.id,
          userId: userSessions.userId,
          userEmail: users.email,
          userName: users.fullName,
          ipAddress: userSessions.ipAddress,
          userAgent: userSessions.userAgent,
          createdAt: userSessions.createdAt,
          lastSeenAt: userSessions.lastSeenAt,
          expiresAt: userSessions.expiresAt,
        })
        .from(userSessions)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, userSessions.userId),
            eq(workspaceMembers.workspaceId, scope.workspaceId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(
          and(
            eq(userSessions.workspaceId, scope.workspaceId),
            isNull(userSessions.revokedAt),
            gt(userSessions.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(userSessions.createdAt))
        .limit(limit);
      return rows;
    });
  },

  /**
   * Is `sessionId` an ACTIVE session belonging to a member of `scope.workspaceId`? The authorization gate
   * for a single-session revoke: runs in the SAME tx as the revoke + audit so the check and the mutation
   * are atomic. Returns the owning userId (for the audit metadata) or null when out of scope / not active.
   */
  async findActiveInWorkspace(
    tx: Tx,
    workspaceId: string,
    sessionId: string,
  ): Promise<{ userId: string } | null> {
    const rows = await tx
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, userSessions.userId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.status, "active"),
        ),
      )
      .where(
        and(
          eq(userSessions.id, sessionId),
          eq(userSessions.workspaceId, workspaceId),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date()), // "active" = same predicate as listForWorkspace
        ),
      )
      .limit(1);
    return rows[0] ? { userId: rows[0].userId } : null;
  },

  /** Revoke a single session inside a caller-provided tx (so it commits with its audit row). */
  async revokeInTx(tx: Tx, sessionId: string): Promise<void> {
    await tx
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
  },

  /**
   * Force re-auth: revoke ALL active sessions of `userId` that are active in `workspaceId`, inside a
   * caller-provided tx. Returns how many rows were revoked (0 if the member has no active sessions here).
   * RLS does not gate user_sessions, so the membership check is the caller's responsibility (the core layer
   * verifies the target is an active member before calling this).
   */
  async revokeAllForMemberInTx(tx: Tx, workspaceId: string, userId: string): Promise<number> {
    const revoked = await tx
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.workspaceId, workspaceId),
          isNull(userSessions.revokedAt),
        ),
      )
      .returning({ id: userSessions.id });
    return revoked.length;
  },
};

/** A session row enriched with its owner for the workspace-admin sessions table (G-AUTH-2). */
export interface AdminSessionRecord {
  id: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
}

// ── Email verification / magic-link / email-OTP tokens (part of the identity aggregate — ADR-0020) ──────
// Only the token HASH is stored; the raw code lives only in the email. The hash is the PK, so re-sending a
// code for the same (email, purpose) first clears the prior unconsumed token. Consumption is atomic.
export interface CreateEmailTokenInput {
  tokenHash: string;
  email: string;
  userId?: string;
  purpose: "verify" | "magic_link" | "email_otp" | "reset";
  expiresAt: Date;
  ipAddress?: string;
}

export const authEmailTokenRepository = {
  async create(input: CreateEmailTokenInput): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(authEmailTokens)
        .where(
          and(
            eq(authEmailTokens.email, input.email),
            eq(authEmailTokens.purpose, input.purpose),
            isNull(authEmailTokens.consumedAt),
          ),
        );
      await tx.insert(authEmailTokens).values({
        tokenHash: input.tokenHash,
        email: input.email,
        userId: input.userId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress,
      });
    });
  },

  // Atomically consume a still-valid token: marks it used and returns true only if it was unconsumed and
  // unexpired (single-use). The token_hash already binds email+purpose+code, so a hit is fully validated.
  async consume(tokenHash: string): Promise<boolean> {
    const rows = await db
      .update(authEmailTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authEmailTokens.tokenHash, tokenHash),
          isNull(authEmailTokens.consumedAt),
          gt(authEmailTokens.expiresAt, new Date()),
        ),
      )
      .returning({ tokenHash: authEmailTokens.tokenHash });
    return rows.length > 0;
  },
};
