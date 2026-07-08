// webauthnCredentialRepository.ts — passkey credential store CRUD (AUTH-024). OWNER connection only:
// webauthn_credentials is REVOKEd from leadwolf_app (see applyMigrations), so these run on the auth service's
// owner pool (`db`), keyed by user_id. No secret is stored (WebAuthn public keys are public). The crypto that
// produces/validates these rows lives in @leadwolf/auth (the review-gated ceremony); this is just persistence.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../client.ts";
import { webauthnCredentials } from "../schema/auth.ts";

export interface NewWebauthnCredential {
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
  aaguid?: string;
  backedUp?: boolean;
  label?: string;
}

/** The fields the assertion/registration paths need — public key + counter for signature verification. */
export interface WebauthnCredentialRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
}

const columns = {
  id: webauthnCredentials.id,
  userId: webauthnCredentials.userId,
  credentialId: webauthnCredentials.credentialId,
  publicKey: webauthnCredentials.publicKey,
  counter: webauthnCredentials.counter,
  transports: webauthnCredentials.transports,
};

/** UI-facing summary of a passkey (never exposes the public key) — for the account "your passkeys" list. */
export interface WebauthnCredentialSummary {
  id: string;
  label: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export const webauthnCredentialRepository = {
  /** A user's registered credentials — used to build `excludeCredentials` (registration) / `allowCredentials`
   *  (authentication) and to look up the public key for assertion verification. */
  async listForUser(userId: string): Promise<WebauthnCredentialRecord[]> {
    return db
      .select(columns)
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
  },

  /** UI summary of a user's passkeys (label / backup-eligible / dates), newest first — no public key. */
  async listSummaryForUser(userId: string): Promise<WebauthnCredentialSummary[]> {
    return db
      .select({
        id: webauthnCredentials.id,
        label: webauthnCredentials.label,
        backedUp: webauthnCredentials.backedUp,
        createdAt: webauthnCredentials.createdAt,
        lastUsedAt: webauthnCredentials.lastUsedAt,
      })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(desc(webauthnCredentials.createdAt));
  },

  /** Remove a passkey, but ONLY if it belongs to `userId` (ownership check — a foreign id matches nothing).
   *  Returns the number of rows deleted (0 = not found / not theirs). */
  async deleteForUser(userId: string, id: string): Promise<number> {
    const rows = await db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning({ id: webauthnCredentials.id });
    return rows.length;
  },

  /** Resolve one credential by its (globally unique) credential id — the assertion lookup. */
  async findByCredentialId(credentialId: string): Promise<WebauthnCredentialRecord | null> {
    const rows = await db
      .select(columns)
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Persist a newly-registered credential (after the attestation verified). credential_id is UNIQUE, so a
   *  duplicate registration of the same authenticator is rejected at the DB. */
  async create(input: NewWebauthnCredential): Promise<void> {
    await db.insert(webauthnCredentials).values({
      userId: input.userId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports,
      aaguid: input.aaguid,
      backedUp: input.backedUp ?? false,
      label: input.label,
    });
  },

  /** Advance the signature counter after a successful assertion (monotonic clone/replay detection) + stamp
   *  last-used. The caller has already verified newCounter > stored counter. */
  async updateCounter(credentialId: string, counter: number): Promise<void> {
    await db
      .update(webauthnCredentials)
      .set({ counter, lastUsedAt: new Date() })
      .where(eq(webauthnCredentials.credentialId, credentialId));
  },
};
