// userRepository.ts — data access for the user/identity aggregate (auth domain): `users` and their
// `user_sessions`. Sessions are co-located here because they belong to the user aggregate (one boundary,
// one domain → auth). Returns typed domain records, never raw rows; the raw refresh token never touches
// the DB (only its hash). findByEmail is the pre-tenant identifier lookup under the auth-service role (17 §1).

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../client.ts";
import { authEmailTokens, userMfaMethods, userSessions, users } from "../schema/auth.ts";

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
};

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
