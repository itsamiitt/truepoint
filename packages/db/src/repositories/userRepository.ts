// userRepository.ts — data access for the user/identity aggregate (auth domain): `users` and their
// `user_sessions`. Sessions are co-located here because they belong to the user aggregate (one boundary,
// one domain → auth). Returns typed domain records, never raw rows; the raw refresh token never touches
// the DB (only its hash). findByEmail is the pre-tenant identifier lookup under the auth-service role (17 §1).

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
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

  // Mirror the IdP's own user id onto the global identity (SCIM externalId → users.scim_external_id). Set on
  // SCIM provision when the IdP supplies an externalId, so the SCIM /Users resource can echo it back and an
  // operator can correlate the row with the IdP. Idempotent; never clears an existing id with a null.
  async setScimExternalId(id: string, externalId: string): Promise<void> {
    await db
      .update(users)
      .set({ scimExternalId: externalId, updatedAt: new Date() })
      .where(eq(users.id, id));
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
    // Exclude `recovery_code` rows (P1-02): recovery codes are a single-use FALLBACK, not a challengeable
    // factor. The login state machine (resolveNextStep) treats any verified row as "MFA enrolled → challenge",
    // and verifyMfaCode only matches `type === 'totp'`; if recovery rows leaked in here, a user whose only real
    // factor was later disabled (recovery rows still verifiedAt) would be routed to an unanswerable /mfa step.
    const rows = await db
      .select({
        type: userMfaMethods.type,
        secretEnc: userMfaMethods.secretEnc,
        verifiedAt: userMfaMethods.verifiedAt,
      })
      .from(userMfaMethods)
      .where(
        and(eq(userMfaMethods.userId, userId), sql`${userMfaMethods.type} <> 'recovery_code'`),
      );
    return rows.map((r) => ({ type: r.type, secretEnc: r.secretEnc, verifiedAt: r.verifiedAt }));
  },

  // ── P1-02 account-security: MFA-method CRUD for the /account/security surface ──────────────────────────
  // The login path keeps the sparse `listMfaMethods` above (verify-only). The self-service UI needs the row
  // id (to disable a specific method) + display metadata, so these return the richer DetailedMfaMethodRecord.
  // EVERY method here scopes its WHERE by `userId` — the caller passes the authenticated session's userId
  // (never a request value), so a user can only ever read/mutate their OWN methods (09 mass-assignment AC).
  // `recovery_code` rows are excluded from the displayed factor list: each code is its own row (so a single
  // code is consumable independently) and is summarised separately via countRecoveryCodes, not shown as a
  // "method". The login verifyMfaCode path only matches `type === "totp"`, so recovery rows never interfere.

  /** Enrolled non-recovery factors for display (id + label + verified/last-used), newest first. */
  async listMfaMethodsDetailed(userId: string): Promise<DetailedMfaMethodRecord[]> {
    const rows = await db
      .select({
        id: userMfaMethods.id,
        type: userMfaMethods.type,
        label: userMfaMethods.label,
        verifiedAt: userMfaMethods.verifiedAt,
        lastUsedAt: userMfaMethods.lastUsedAt,
        createdAt: userMfaMethods.createdAt,
      })
      .from(userMfaMethods)
      .where(
        and(eq(userMfaMethods.userId, userId), sql`${userMfaMethods.type} <> 'recovery_code'`),
      )
      .orderBy(desc(userMfaMethods.createdAt));
    return rows;
  },

  /**
   * Insert a new MFA method bound to `userId` and return its id. The secret is already encrypted by the auth
   * layer (secrets.ts) — this only persists the ciphertext. Pass `verified: true` to set `verifiedAt` at insert
   * (the enroll flow verifies the first code BEFORE persisting, so the row is born verified and no orphan
   * pending row is ever left behind). The userId is the authenticated session's, never a body value (09
   * MFA-integrity AC: the new secret binds to THIS user).
   */
  async createMfaMethod(input: {
    userId: string;
    type: string;
    secretEnc: Uint8Array;
    label?: string | null;
    verified?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(userMfaMethods)
      .values({
        userId: input.userId,
        type: input.type,
        secretEnc: input.secretEnc,
        label: input.label ?? null,
        verifiedAt: input.verified ? new Date() : null,
      })
      .returning({ id: userMfaMethods.id });
    return row!.id;
  },

  /** Delete a method by (id, userId). Returns how many rows were removed (0 = not theirs / already gone). */
  async deleteMfaMethod(userId: string, methodId: string): Promise<number> {
    const rows = await db
      .delete(userMfaMethods)
      .where(and(eq(userMfaMethods.id, methodId), eq(userMfaMethods.userId, userId)))
      .returning({ id: userMfaMethods.id });
    return rows.length;
  },

  // ── Recovery codes (stored as user_mfa_methods rows of type 'recovery_code') ───────────────────────────
  // One row per code: `secret_enc` holds the SHA-256 HASH of the code as bytea (never the plaintext, never
  // encrypted-reversible — a one-way hash, like a password digest). `verified_at` is set at creation (a
  // recovery code is active immediately); `last_used_at` is stamped on consumption (single-use). Shown to the
  // user exactly ONCE at generation (09 secrets AC). Reusing the existing table avoids a new migration the
  // sandbox cannot generate, and matches how the app SecurityPanel already models `recovery_codes` as a factor.

  /** Atomically replace ALL of a user's recovery codes with a fresh hashed set (regenerate). */
  async replaceRecoveryCodes(userId: string, codeHashes: Uint8Array[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(userMfaMethods)
        .where(and(eq(userMfaMethods.userId, userId), eq(userMfaMethods.type, "recovery_code")));
      if (codeHashes.length > 0) {
        await tx.insert(userMfaMethods).values(
          codeHashes.map((h) => ({
            userId,
            type: "recovery_code",
            secretEnc: h,
            verifiedAt: new Date(),
          })),
        );
      }
    });
  },

  /** Count the user's UNUSED recovery codes (for the "N of M remaining" status line). */
  async countRecoveryCodes(userId: string): Promise<number> {
    const rows = await db
      .select({ id: userMfaMethods.id })
      .from(userMfaMethods)
      .where(
        and(
          eq(userMfaMethods.userId, userId),
          eq(userMfaMethods.type, "recovery_code"),
          isNull(userMfaMethods.lastUsedAt),
        ),
      );
    return rows.length;
  },
};

export interface MfaMethodRecord {
  type: string;
  secretEnc: Uint8Array | null;
  verifiedAt: Date | null;
}

/** A richer MFA-method view for the /account/security surface — carries the row id + display metadata. */
export interface DetailedMfaMethodRecord {
  id: string;
  type: string;
  label: string | null;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
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
  // Session creation time. Additive and OPTIONAL to the P1-01 Gate D enforcement: the absolute session-timeout
  // cap is currently anchored on the session's own `expiresAt` (set to min(default, now+cap) at login and held
  // "sticky" across refresh rotations via notLaterThan), so the refresh path does NOT read createdAt today. It
  // is surfaced here for the DEFERRED idle/absolute follow-up (and for admin/observability). Existing consumers
  // ignore it; it never changes the OFF-by-default behavior.
  createdAt: Date;
  // Time of last activity — stamped `now` at create and on every refresh rotation (so it tracks the last
  // refresh). The IDLE-window boundary (P1-01 Gate D) reads this on the refresh path: a refresh past
  // idleTimeoutSeconds since lastSeenAt is rejected. Null only for pre-existing rows written before the
  // column existed; the idle gate treats null as "no idle data" and does not reject on it.
  lastSeenAt: Date | null;
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

/** A user's OWN session enriched with device/IP/last-seen for the /account/security sessions + history views. */
export interface OwnSessionRecord {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
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
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
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

  // P1-02 self-service "my sessions / login history" read: the user's OWN sessions enriched with the device
  // (User-Agent), IP, and last-seen the SessionRecord shape omits — for the /account/security sessions table.
  // Scoped to `userId` (the authenticated session's). Returns active AND historical rows (the caller filters);
  // `revokedAt` distinguishes them for the login-history vs active-sessions split. Newest first.
  async listOwnSessionsDetailed(userId: string, limit = 50): Promise<OwnSessionRecord[]> {
    const rows = await db
      .select({
        id: userSessions.id,
        ipAddress: userSessions.ipAddress,
        userAgent: userSessions.userAgent,
        createdAt: userSessions.createdAt,
        lastSeenAt: userSessions.lastSeenAt,
        expiresAt: userSessions.expiresAt,
        revokedAt: userSessions.revokedAt,
      })
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .orderBy(desc(userSessions.createdAt))
      .limit(limit);
    return rows;
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

  /**
   * Global force-logout: revoke EVERY active session of `userId` across ALL orgs/workspaces and return the
   * revoked session ids, so the caller can add them to the access-token revocation deny-list for immediate
   * effect (not just when the ≤15-min access token expires). Used on password reset/change (17 §revocation).
   * user_sessions has no tenant RLS, and this is a self-service "log me out everywhere" by user id — no
   * workspace scoping (unlike revokeAllForMemberInTx, the admin "revoke this member's sessions here" path).
   */
  async revokeAllForUser(userId: string): Promise<string[]> {
    const revoked = await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });
    return revoked.map((r) => r.id);
  },

  // ── P1-02 self-service "manage my own sessions" ───────────────────────────────────────────────────────
  // The user-scoped analogue of the workspace-admin revokes. EVERY method is keyed by `userId` (the
  // authenticated session's), so a user can only ever revoke a session that is genuinely THEIRS — a foreign
  // session id supplied in the request body matches nothing and is a no-op (09 access / IDOR AC). Returns the
  // revoked id(s) so the caller can deny-list the still-live access token(s) for immediate effect.

  /** Revoke a SINGLE session, but only if it belongs to `userId` and is still active. Returns the id or null. */
  async revokeOwnSession(userId: string, sessionId: string): Promise<string | null> {
    const revoked = await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.id, sessionId),
          eq(userSessions.userId, userId), // ownership: never trust the id alone
          isNull(userSessions.revokedAt),
        ),
      )
      .returning({ id: userSessions.id });
    return revoked[0]?.id ?? null;
  },

  /** Revoke ALL of the user's active sessions EXCEPT `exceptSessionId` (sign out everywhere else). */
  async revokeOtherSessionsForUser(userId: string, exceptSessionId: string): Promise<string[]> {
    const revoked = await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          sql`${userSessions.id} <> ${exceptSessionId}`,
        ),
      )
      .returning({ id: userSessions.id });
    return revoked.map((r) => r.id);
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
