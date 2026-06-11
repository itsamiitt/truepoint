// dsarRepository.ts — data access for the platform-owned dsar_requests workflow (compliance domain,
// 08 §4). Intake runs on the base/system path (the public form carries no tenant session); processing and
// status transitions run under the privileged role — rls/compliance.sql denies the app role entirely.

import { eq, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { dsarRequests } from "../schema/compliance.ts";

export interface DsarCreateInput {
  requestType: "access" | "delete" | "rectify";
  subjectEmailEnc: Uint8Array;
  subjectEmailBlindIndex: Uint8Array;
}

export interface DsarRow {
  id: string;
  requestType: string;
  status: string;
  scopeReport: unknown;
  requestedAt: Date;
  completedAt: Date | null;
}

export const dsarRequestRepository = {
  /** Public intake (system path): the request exists before any verification. */
  async create(input: DsarCreateInput): Promise<string> {
    const rows = await db.insert(dsarRequests).values(input).returning({ id: dsarRequests.id });
    return rows[0]!.id;
  },

  async getById(tx: Tx, id: string): Promise<DsarRow | null> {
    const rows = await tx
      .select({
        id: dsarRequests.id,
        requestType: dsarRequests.requestType,
        status: dsarRequests.status,
        scopeReport: dsarRequests.scopeReport,
        requestedAt: dsarRequests.requestedAt,
        completedAt: dsarRequests.completedAt,
      })
      .from(dsarRequests)
      .where(eq(dsarRequests.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async setStatus(
    tx: Tx,
    id: string,
    status: "verifying" | "processing" | "completed" | "rejected",
    patch: { scopeReport?: unknown; verifiedAt?: Date; completedAt?: Date } = {},
  ): Promise<void> {
    await tx
      .update(dsarRequests)
      .set({ status, ...patch })
      .where(eq(dsarRequests.id, id));
  },
};

// ── The cross-workspace fan-out queries (08 §4, H6) — PRIVILEGED-tx only (withPrivilegedTx) ────────────

export interface SubjectCopy {
  contactId: string;
  tenantId: string;
  workspaceId: string;
  isRevealed: boolean;
  deletedAt: Date | null;
}

export const dsarFanoutRepository = {
  /** Every per-workspace copy of the subject, across ALL tenants (the find-everywhere enumeration). */
  async findCopies(tx: Tx, emailBlindIndex: Uint8Array): Promise<SubjectCopy[]> {
    const rows = (await tx.execute(sql`
      SELECT id AS contact_id, tenant_id, workspace_id, is_revealed, deleted_at
      FROM contacts WHERE email_blind_index = ${emailBlindIndex}
    `)) as unknown as Array<{
      contact_id: string;
      tenant_id: string;
      workspace_id: string;
      is_revealed: boolean;
      deleted_at: Date | null;
    }>;
    return rows.map((r) => ({
      contactId: r.contact_id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      isRevealed: r.is_revealed,
      deletedAt: r.deleted_at,
    }));
  },

  /** Tombstone one copy: deleted_at + every PII column nulled, incl. the blind index (erasure forgets the key). */
  async tombstone(tx: Tx, contactId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE contacts SET deleted_at = now(), first_name = NULL, last_name = NULL,
        email_enc = NULL, email_blind_index = NULL, email_domain = NULL,
        phone_enc = NULL, linkedin_url = NULL, linkedin_public_id = NULL,
        sales_nav_profile_url = NULL, sales_nav_lead_id = NULL
      WHERE id = ${contactId}
    `);
  },

  /** Purge the copy's dependents (08 §4.2): provenance, reveal events, consent rows. */
  async purgeDependents(tx: Tx, contactIds: string[]): Promise<void> {
    if (contactIds.length === 0) return;
    // Pass ids as a Postgres array LITERAL ('{a,b}') — drizzle's sql template does not parameterize JS
    // arrays as SQL arrays.
    const ids = `{${contactIds.join(",")}}`;
    await tx.execute(sql`DELETE FROM source_imports WHERE contact_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM contact_reveals WHERE contact_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM consent_records WHERE contact_id = ANY(${ids}::uuid[])`);
  },

  /** The verification scan (08 §4.2 step 6): zero residual PII anywhere, or the job must not complete. */
  async scanResiduals(
    tx: Tx,
    emailBlindIndex: Uint8Array,
    contactIds: string[],
  ): Promise<{ liveCopies: number; piiOnTombstones: number; dependents: number }> {
    const [live] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE email_blind_index = ${emailBlindIndex} AND deleted_at IS NULL
    `)) as unknown as Array<{ n: number }>;
    const idList = contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"];
    const ids = `{${idList.join(",")}}`; // array literal — see purgeDependents
    const [pii] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE id = ANY(${ids}::uuid[])
        AND (email_enc IS NOT NULL OR phone_enc IS NOT NULL OR first_name IS NOT NULL
             OR last_name IS NOT NULL OR linkedin_url IS NOT NULL)
    `)) as unknown as Array<{ n: number }>;
    const [dep] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM source_imports WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM contact_reveals WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM consent_records WHERE contact_id = ANY(${ids}::uuid[]))::int AS n
    `)) as unknown as Array<{ n: number }>;
    return {
      liveCopies: Number(live?.n ?? 0),
      piiOnTombstones: Number(pii?.n ?? 0),
      dependents: Number(dep?.n ?? 0),
    };
  },

  /** Per-copy data footprint for the access report (08 §4.1). */
  async copyFootprint(
    tx: Tx,
    contactId: string,
  ): Promise<{ sourceImports: number; reveals: number; consentRecords: number }> {
    const [counts] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM source_imports WHERE contact_id = ${contactId})::int AS imports,
             (SELECT count(*) FROM contact_reveals WHERE contact_id = ${contactId})::int AS reveals,
             (SELECT count(*) FROM consent_records WHERE contact_id = ${contactId})::int AS consents
    `)) as unknown as Array<{ imports: number; reveals: number; consents: number }>;
    return {
      sourceImports: Number(counts?.imports ?? 0),
      reveals: Number(counts?.reveals ?? 0),
      consentRecords: Number(counts?.consents ?? 0),
    };
  },

  /** Global-scope suppression so no source re-imports the subject and no send can reach them (08 §4.2 step 4). */
  async addGlobalSuppression(tx: Tx, emailBlindIndex: Uint8Array, reason: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO suppression_list (scope, match_type, email_blind_index, reason)
      VALUES ('global', 'email', ${emailBlindIndex}, ${reason})
    `);
  },
};
