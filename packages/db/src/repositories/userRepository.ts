// userRepository.ts — data access for the user/identity aggregate (auth domain): `users` and their
// `user_sessions`. Sessions are co-located here because they belong to the user aggregate (one boundary,
// one domain → auth). Returns typed domain records, never raw rows; the raw refresh token never touches
// the DB (only its hash). findByEmail is the pre-tenant identifier lookup under the auth-service role (17 §1).

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../client.ts";
import { userMfaMethods, users, userSessions } from "../schema/auth.ts";

// ── Users ────────────────────────────────────────────────────────────────────────────────────────────
export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  fullName: string | null;
  passwordHash: string | null;
  authProvider: string;
  isTenantOwner: boolean;
  status: string;
}

type UserRow = typeof users.$inferSelect;
const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  tenantId: r.tenantId,
  email: r.email,
  fullName: r.fullName,
  passwordHash: r.passwordHash,
  authProvider: r.authProvider,
  isTenantOwner: r.isTenantOwner,
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

  async touchLastLogin(id: string): Promise<void> {
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, id));
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
  appOrigin?: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

type SessionRow = typeof userSessions.$inferSelect;
const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userId: r.userId,
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

  async rotate(args: { oldId: string; next: CreateSessionInput }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, args.oldId));
      await tx.insert(userSessions).values({ ...args.next, rotatedFrom: args.oldId, lastSeenAt: new Date() });
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
