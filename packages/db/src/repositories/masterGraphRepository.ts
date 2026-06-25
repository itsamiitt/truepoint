// masterGraphRepository.ts — the Layer-0 deterministic resolve-for-import data access (ADR-0021 MATCH-AGAINST;
// prospect-company-data PLAN_01 §4 + §5.3, PLAN_02 §1). Given a normalized import row's match keys, resolve it to
// a golden master_persons / master_companies pair — LINKing an existing entity by a deterministic key, or MINTing
// a fresh, co-op-safe golden node on a clean miss. Always called inside withErTx (the least-privilege leadwolf_er
// role); the master tables are system-owned and NOT RLS-scoped, so there are no tenant GUCs (PLAN_01 §5).
//
// ── THE CO-OP-SAFE MINT BOUNDARY (security-critical — co-op/CONTRIBUTE-TO is OFF by default, ADR-0021) ──────────
// A non-co-op workspace import resolves AGAINST the shared graph but must NEVER make its PII or contributed
// profile fields revealable to OTHER workspaces. So a MATCH-AGAINST mint writes ONLY non-revealable identity +
// dedup data, never a revealable value or a contributed profile field (PLAN_01 §5.3):
//   • master_companies — primary_domain + name(= companyName ?? domain). Nothing else.
//   • master_persons   — linkedin_public_id (if present) + current_company_id; has_email/has_phone = FALSE.
//                        NEVER full_name/first_name/last_name/job_title/department — those PII VALUES stay in the
//                        caller's overlay, not the golden row.
//   • master_emails    — email_blind_index (HMAC dedup/DSAR key) + email_domain (public facet); email_enc = NULL
//                        (the revealable value is NOT contributed — only a paid provider/opt-in co-op source does).
//   • master_employment — minted only on a NEW person mint when a company resolved: the bare edge
//                        (is_current/is_primary), NO title/department.
// MATCH-AGAINST writes NO source_records, NO field_provenance, NO match_links — those are provenance, and only the
// opt-in CONTRIBUTE-TO path writes provenance (PLAN_01 §5.3). On a LINK (an existing master found by a
// deterministic key) we mutate NOTHING: pure read + return the id, zero contribution.
//
// Concurrency: the global UNIQUE constraints (primary_domain partial-unique, email_blind_index, linkedin_public_id)
// are the guard (PLAN_01 §4, 03:716) — every insert is an ON CONFLICT DO NOTHING followed by a re-SELECT, so two
// concurrent ingests of the same entity converge on one row instead of double-inserting.
//
// Phone resolution is DEFERRED (the import carries no phone blind index yet) — phoneBlindIndex is accepted in the
// input shape for forward-compat but is not read.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** The normalized match keys a resolve-for-import probe carries (the output of matchKeys.ts, PLAN_01 §4 Stage 1). */
export interface ResolveForImportInput {
  linkedinPublicId?: string; // strongest person key (master_persons.linkedin_public_id UNIQUE)
  emailBlindIndex?: Uint8Array; // HMAC dedup/DSAR key (master_emails.email_blind_index UNIQUE)
  emailDomain?: string; // public facet stored alongside the blind index (NOT the revealable value)
  phoneBlindIndex?: Uint8Array; // DEFERRED — accepted for forward-compat, not read yet
  registrableDomain?: string; // PSL eTLD+1, free-mail-excluded by the caller (master_companies.primary_domain UNIQUE)
  companyName?: string; // display name for a freshly minted company (falls back to the domain)
}

/** A LINK to / MINT of the golden pair. masterCompanyId is null for a company-less / domainless person. */
export interface ResolveForImportResult {
  masterPersonId: string;
  masterCompanyId: string | null;
}

/** Resolve a company by its registrable domain — LINK if it exists, else co-op-safe MINT. Returns null when the
 *  input carries no domain (company-less person; the free-mail guard lives in the caller, PLAN_01 §4 F4). */
async function resolveCompany(tx: Tx, input: ResolveForImportInput): Promise<string | null> {
  const domain = input.registrableDomain;
  if (!domain) return null;

  // citext equality — primary_domain is citext, so the comparison is case-insensitive without lower().
  const existing = (await tx.execute(
    sql`SELECT id FROM master_companies WHERE primary_domain = ${domain} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  if (existing[0]) return existing[0].id;

  // MINT — primary_domain + name only (the co-op-safe boundary). ON CONFLICT on the partial unique
  // (uniq_master_companies_primary_domain WHERE primary_domain IS NOT NULL) so a concurrent insert can't double up.
  await tx.execute(
    sql`INSERT INTO master_companies (primary_domain, name)
        VALUES (${domain}, ${input.companyName ?? domain})
        ON CONFLICT (primary_domain) WHERE primary_domain IS NOT NULL DO NOTHING`,
  );
  // Re-SELECT to get the id whether we won the insert or lost the race to a concurrent minter.
  const minted = (await tx.execute(
    sql`SELECT id FROM master_companies WHERE primary_domain = ${domain} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  return minted[0]?.id ?? null;
}

/** Find an existing golden person by a deterministic key (linkedin_public_id, then email_blind_index). LINK only. */
async function findPerson(tx: Tx, input: ResolveForImportInput): Promise<string | null> {
  if (input.linkedinPublicId) {
    const r = (await tx.execute(
      sql`SELECT id FROM master_persons WHERE linkedin_public_id = ${input.linkedinPublicId} LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    if (r[0]) return r[0].id;
  }
  if (input.emailBlindIndex) {
    const r = (await tx.execute(
      sql`SELECT master_person_id FROM master_emails WHERE email_blind_index = ${input.emailBlindIndex} LIMIT 1`,
    )) as unknown as Array<{ master_person_id: string }>;
    if (r[0]) return r[0].master_person_id;
  }
  return null;
}

export const masterGraphRepository = {
  /**
   * Deterministic MATCH-AGAINST resolve-for-import (ADR-0021; PLAN_01 §4/§5.3). Runs entirely under the caller's
   * `tx` (a withErTx transaction). LINKs an existing golden pair by a deterministic key, or co-op-safely MINTs.
   * See the file header for the exact fields a mint may and may not write — the security boundary is load-bearing.
   */
  async resolveForImport(tx: Tx, input: ResolveForImportInput): Promise<ResolveForImportResult> {
    // 1) Company — LINK-or-MINT by registrable domain (null = company-less person). Resolved first so a fresh
    //    person mint can point current_company_id at it and open the bare employment edge.
    const masterCompanyId = await resolveCompany(tx, input);

    // 2) Person — LINK if a deterministic key hits (mutate NOTHING), else MINT a co-op-safe golden node.
    const existingPersonId = await findPerson(tx, input);
    if (existingPersonId) {
      // LINK — pure read + return; zero contribution (no field write, no edge upsert). PLAN_01 §5.3.
      return { masterPersonId: existingPersonId, masterCompanyId };
    }

    // MINT — identity + dedup only. NEVER full_name/first_name/last_name/job_title/department (PII VALUES, overlay
    // only). has_email/has_phone stay FALSE: the blind-index facet is a dedup key, not a contributed channel value.
    const minted = (await tx.execute(
      sql`INSERT INTO master_persons (linkedin_public_id, current_company_id, has_email, has_phone)
          VALUES (${input.linkedinPublicId ?? null}, ${masterCompanyId}, false, false)
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    let masterPersonId = minted[0]!.id;

    // 3) Email channel — store the blind-index dedup/DSAR key + the public domain facet ONLY; email_enc = NULL (the
    //    revealable value is NOT contributed by MATCH-AGAINST). If the blind index already belongs to another master
    //    (a concurrent/earlier mint won the email), DO NOTHING then re-resolve: that other master is the canonical
    //    person for this email — prefer it and discard the empty person we just minted (acceptable edge-case TODO:
    //    the discarded empty master_persons row is harmless and swept by the deferred ER merge, PLAN_01 §4 F1/F8).
    if (input.emailBlindIndex) {
      await tx.execute(
        sql`INSERT INTO master_emails (master_person_id, email_blind_index, email_domain)
            VALUES (${masterPersonId}, ${input.emailBlindIndex}, ${input.emailDomain ?? null})
            ON CONFLICT (email_blind_index) DO NOTHING`,
      );
      const owner = (await tx.execute(
        sql`SELECT master_person_id FROM master_emails WHERE email_blind_index = ${input.emailBlindIndex} LIMIT 1`,
      )) as unknown as Array<{ master_person_id: string }>;
      if (owner[0] && owner[0].master_person_id !== masterPersonId) {
        // Another master already owns this email — that is the canonical person; discard the just-minted empty one.
        masterPersonId = owner[0].master_person_id;
        return { masterPersonId, masterCompanyId };
      }
    }

    // 4) Employment edge — only on a fresh person mint when a company resolved. The BARE edge (is_current/is_primary
    //    default true), NO title/department. ON CONFLICT on the stint dedup unique (person, company, started_on) so
    //    a concurrent mint of the same pair collapses to one edge (PLAN_02 §0.1; started_on defaults to '-infinity').
    if (masterCompanyId) {
      await tx.execute(
        sql`INSERT INTO master_employment (master_person_id, master_company_id, is_current, is_primary)
            VALUES (${masterPersonId}, ${masterCompanyId}, true, true)
            ON CONFLICT (master_person_id, master_company_id, started_on) DO NOTHING`,
      );
    }

    return { masterPersonId, masterCompanyId };
  },
};
