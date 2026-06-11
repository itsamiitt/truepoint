// contactRepository.ts — data access for `contacts` (reveal/contacts domain). Holds the per-workspace dedup
// lookups + writes used by the import pipeline (tx-aware, composed inside one withTenantTx), plus the
// self-contained masked list the API/search surfaces read. PII (email/phone) is stored encrypted; this
// layer never returns plaintext — callers see only the non-PII facets until reveal (M3). 03 §5/§9.

import type { MaskedContact } from "@leadwolf/types";
import { and, desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";

/** The dedup keys, in priority order: a match on any identifies the same person within the workspace. */
export interface DedupKeys {
  emailBlindIndex?: Uint8Array;
  linkedinPublicId?: string;
  salesNavLeadId?: string;
}

/** The writable columns the import pipeline computes for a contact. PII arrives already encrypted. */
export interface ContactWriteValues {
  tenantId: string;
  workspaceId: string;
  accountId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emailEnc?: Uint8Array | null;
  emailBlindIndex?: Uint8Array | null;
  emailDomain?: string | null;
  jobTitle?: string | null;
  seniorityLevel?: string | null;
  department?: string | null;
  phoneEnc?: Uint8Array | null;
  emailStatus?: string; // verification result (06 §9; NOT NULL column) — set by verify-on-reveal / enrichment
  phoneStatus?: string | null;
  linkedinUrl?: string | null;
  linkedinPublicId?: string | null;
  salesNavProfileUrl?: string | null;
  salesNavLeadId?: string | null;
  locationCountry?: string | null;
  locationCity?: string | null;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

export const contactRepository = {
  /** Find an existing contact in the workspace by the first dedup key that hits (email → linkedin → sales-nav). */
  async findByDedupKeys(
    tx: Tx,
    workspaceId: string,
    keys: DedupKeys,
  ): Promise<{ id: string } | null> {
    if (keys.emailBlindIndex) {
      const r = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.emailBlindIndex, keys.emailBlindIndex),
          ),
        )
        .limit(1);
      if (r[0]) return r[0];
    }
    if (keys.linkedinPublicId) {
      const r = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.linkedinPublicId, keys.linkedinPublicId),
          ),
        )
        .limit(1);
      if (r[0]) return r[0];
    }
    if (keys.salesNavLeadId) {
      const r = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.salesNavLeadId, keys.salesNavLeadId),
          ),
        )
        .limit(1);
      if (r[0]) return r[0];
    }
    return null;
  },

  /** Insert a new contact; returns its id. (undefined optional fields fall back to column defaults/null.) */
  async insert(tx: Tx, values: ContactWriteValues): Promise<string> {
    const rows = await tx.insert(contacts).values(values).returning({ id: contacts.id });
    return rows[0]!.id;
  },

  /** Merge non-undefined fields into an existing contact (sparse re-imports never wipe known values). */
  async update(tx: Tx, id: string, values: Partial<ContactWriteValues>): Promise<void> {
    await tx
      .update(contacts)
      .set({ ...definedOnly(values), updatedAt: new Date() })
      .where(eq(contacts.id, id));
  },

  /** The non-PII inputs the rule-based scorer reads (ADR-0008). Tx-aware: composed in the score tx. */
  async getScoringInputs(
    tx: Tx,
    contactId: string,
  ): Promise<{
    seniorityLevel: string | null;
    jobTitle: string | null;
    emailDomain: string | null;
    hasEmail: boolean;
  } | null> {
    const rows = await tx
      .select({
        seniorityLevel: contacts.seniorityLevel,
        jobTitle: contacts.jobTitle,
        emailDomain: contacts.emailDomain,
        emailEnc: contacts.emailEnc,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          seniorityLevel: r.seniorityLevel,
          jobTitle: r.jobTitle,
          emailDomain: r.emailDomain,
          hasEmail: r.emailEnc != null,
        }
      : null;
  },

  /** Masked, workspace-scoped list for the search/results + post-import surfaces. Never returns PII. */
  async listByWorkspace(scope: TenantScope, limit = 100): Promise<MaskedContact[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx.select().from(contacts).orderBy(desc(contacts.createdAt)).limit(limit);
      return rows.map((r) => ({
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        jobTitle: r.jobTitle,
        emailDomain: r.emailDomain,
        emailStatus: r.emailStatus as MaskedContact["emailStatus"],
        hasEmail: r.emailEnc != null,
        hasPhone: r.phoneEnc != null,
        seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
        department: r.department,
        locationCountry: r.locationCountry,
        locationCity: r.locationCity,
        outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
        isRevealed: r.isRevealed,
      }));
    });
  },
};
