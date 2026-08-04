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
//
// ── THE CONTRIBUTION GATE (Phase 4) ──────────────────────────────────────────────────────────────────────────
// ResolveForImportOptions lets an overlay-side caller restrict what a resolve may WRITE, never what it may
// read. `matchOnly` LINKs normally and mints nothing; the withhold* flags drop individual facets from a mint.
// The policy behind those flags (contribution_policy / contribution_exclusion) is workspace-scoped and lives
// under RLS in `public`, where leadwolf_er has no grant — so the decision is made in
// core/prospect/contributionGate.ts and carried in, exactly as match keys already are. Passing no options
// leaves every statement below byte-identical to what it was before the gate existed.

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

/**
 * Per-call contribution restrictions, supplied by the overlay-side gate (core/prospect/contributionGate.ts).
 *
 * The resolver cannot decide these itself: the policy and exclusion tables are workspace-scoped and live in
 * `public` under RLS, and this code runs as leadwolf_er, which has no grant on them. So the decision is made
 * on the overlay side and carried in — the same split runImport already uses for match keys.
 *
 * `matchOnly` is the load-bearing one. It LINKs exactly as normal and MINTs nothing, so a workspace that has
 * not opted in (or that excluded this account) still gets every benefit of what is already in the shared
 * graph and only stops ADDING to it. Denying the link too would be a product downgrade wearing a privacy
 * control's name.
 */
export interface ResolveForImportOptions {
  matchOnly?: boolean;
  withholdEmail?: boolean;
  withholdCompany?: boolean;
  withholdEmployment?: boolean;
  withholdLinkedin?: boolean;
}

/** A LINK to / MINT of the golden pair. masterCompanyId is null for a company-less / domainless person;
 *  masterPersonId is null when the row carries NO person key (no linkedin, no email) — we do NOT mint an
 *  anonymous, un-dedupable identity (pure graph noise); the overlay stays unresolved (in-flight staging). */
export interface ResolveForImportResult {
  masterPersonId: string | null;
  masterCompanyId: string | null;
  /** True when a restriction stopped a mint that would otherwise have happened. Lets the caller count what the
   *  gate actually cost rather than inferring it from a null, which is also what a keyless row returns. */
  mintSuppressed?: boolean;
}

/** Resolve a company by its registrable domain — LINK if it exists, else co-op-safe MINT. Returns null when the
 *  input carries no domain (company-less person; the free-mail guard lives in the caller, PLAN_01 §4 F4). */
async function resolveCompany(
  tx: Tx,
  input: ResolveForImportInput,
  opts?: ResolveForImportOptions,
): Promise<string | null> {
  const domain = input.registrableDomain;
  if (!domain) return null;

  // citext equality — primary_domain is citext, so the comparison is case-insensitive without lower().
  const existing = (await tx.execute(
    sql`SELECT id FROM master_companies WHERE primary_domain = ${domain} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  if (existing[0]) return existing[0].id;

  // A restricted caller LINKs but never mints — the lookup above already ran, so an existing company is still
  // returned and only the creation of a NEW one is withheld.
  if (opts?.matchOnly || opts?.withholdCompany) return null;

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
  async resolveForImport(
    tx: Tx,
    input: ResolveForImportInput,
    opts?: ResolveForImportOptions,
  ): Promise<ResolveForImportResult> {
    // 1) Company — LINK-or-MINT by registrable domain (null = company-less person). Resolved first so a fresh
    //    person mint can point current_company_id at it and open the bare employment edge.
    const masterCompanyId = await resolveCompany(tx, input, opts);

    // 1b) No person key at all (no linkedin_public_id AND no email_blind_index) → there is nothing to dedup on,
    //     so do NOT mint an anonymous master_persons: it could never be matched or merged by later ER, so every
    //     keyless row would mint its own permanent junk identity. Resolve the company (if any) and leave the
    //     person UNRESOLVED (the overlay master_person_id stays NULL — in-flight staging, ADR-0021). A
    //     sales-nav-only / name-only contact thus resolves its company but not (yet) its golden person.
    if (!input.linkedinPublicId && !input.emailBlindIndex) {
      return { masterPersonId: null, masterCompanyId };
    }

    // 2) Person — LINK if a deterministic key hits (mutate NOTHING), else MINT a co-op-safe golden node.
    const existingPersonId = await findPerson(tx, input);
    if (existingPersonId) {
      // LINK — pure read + return; zero contribution (no field write, no edge upsert). PLAN_01 §5.3. Reached
      // by restricted callers too: the link is a read of what is already shared, not a contribution.
      return { masterPersonId: existingPersonId, masterCompanyId };
    }

    // The contribution gate, at the one statement that actually contributes. Nothing matched, so continuing
    // would CREATE a globally visible node out of this workspace's data. A restricted caller stops here and
    // the overlay bridge stays NULL — the same in-flight-staging state a keyless row leaves, and re-resolvable
    // for free the day the customer opts in or an outside source mints the person independently.
    if (opts?.matchOnly) {
      return { masterPersonId: null, masterCompanyId, mintSuppressed: true };
    }

    // Which identity keys a RESTRICTED mint may actually write. Withholding governs what we WRITE, never what
    // we read — findPerson above deliberately searched on the full input, because finding a person who is
    // already in the graph is a read and costs the customer nothing.
    const mintLinkedin = opts?.withholdLinkedin ? null : (input.linkedinPublicId ?? null);
    const mintEmailBlindIndex = opts?.withholdEmail ? undefined : input.emailBlindIndex;

    // Withholding BOTH keys would mint an anonymous row: no linkedin id, no email facet, nothing later ER
    // could ever match or merge it on. That is precisely the permanent junk identity the keyless guard exists
    // to prevent, arrived at by a different route — so take the same exit rather than creating graph noise in
    // the name of privacy.
    if (!mintLinkedin && !mintEmailBlindIndex) {
      return { masterPersonId: null, masterCompanyId, mintSuppressed: true };
    }

    // MINT — identity + dedup only. NEVER full_name/first_name/last_name/job_title/department (PII VALUES, overlay
    // only). has_email/has_phone stay FALSE: the blind-index facet is a dedup key, not a contributed channel value.
    // current_company_id is withheld alongside the employment edge: the scalar states the same fact the edge
    // does ("this person works at X"), so honouring one and not the other would leak exactly what was refused.
    // The company itself may still LINK — it is the person-to-company association that is withheld.
    const mintCurrentCompanyId = opts?.withholdEmployment ? null : masterCompanyId;
    const minted = (await tx.execute(
      sql`INSERT INTO master_persons (linkedin_public_id, current_company_id, has_email, has_phone)
          VALUES (${mintLinkedin}, ${mintCurrentCompanyId}, false, false)
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    let masterPersonId = minted[0]!.id;

    // 3) Email channel — store the blind-index dedup/DSAR key + the public domain facet ONLY; email_enc = NULL (the
    //    revealable value is NOT contributed by MATCH-AGAINST). If the blind index already belongs to another master
    //    (a concurrent/earlier mint won the email), DO NOTHING then re-resolve: that other master is the canonical
    //    person for this email — prefer it and discard the empty person we just minted (acceptable edge-case TODO:
    //    the discarded empty master_persons row is harmless and swept by the deferred ER merge, PLAN_01 §4 F1/F8).
    if (mintEmailBlindIndex) {
      await tx.execute(
        sql`INSERT INTO master_emails (master_person_id, email_blind_index, email_domain)
            VALUES (${masterPersonId}, ${mintEmailBlindIndex}, ${input.emailDomain ?? null})
            ON CONFLICT (email_blind_index) DO NOTHING`,
      );
      const owner = (await tx.execute(
        sql`SELECT master_person_id FROM master_emails WHERE email_blind_index = ${mintEmailBlindIndex} LIMIT 1`,
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
    if (masterCompanyId && !opts?.withholdEmployment) {
      await tx.execute(
        sql`INSERT INTO master_employment (master_person_id, master_company_id, is_current, is_primary)
            VALUES (${masterPersonId}, ${masterCompanyId}, true, true)
            ON CONFLICT (master_person_id, master_company_id, started_on) DO NOTHING`,
      );
    }

    return { masterPersonId, masterCompanyId };
  },

  /**
   * Batched MATCH-AGAINST for a whole import chunk (15-bulk-import-design §2): run the UNCHANGED single-row
   * resolveForImport once per input, but inside the caller's ONE withErTx — collapsing today's "one withErTx
   * per row" into "one per chunk". This is a THIN LOOP by design: only the transaction count changes. The
   * co-op-safe MINT boundary is byte-for-byte IDENTICAL — each identity still LINKs-or-MINTs exactly as the
   * single-row path (identity/dedup only; never revealable PII or contributed profile fields; see the file
   * header). Mints stay per-identity, the global UNIQUE constraints stay the concurrency guard; no set-based
   * mint over staging (which would breach the leadwolf_er trust boundary). Results are index-aligned to inputs.
   *
   * `optsFor` supplies PER-ROW contribution restrictions rather than one set for the chunk: an exclusion list
   * is written per account and per contact, so two rows in the same import can legitimately get different
   * answers. A chunk-wide option would force the batch path to either over- or under-apply the customer's rules.
   */
  async resolveForImportBatch(
    tx: Tx,
    inputs: ResolveForImportInput[],
    optsFor?: (input: ResolveForImportInput, index: number) => ResolveForImportOptions | undefined,
  ): Promise<ResolveForImportResult[]> {
    const results: ResolveForImportResult[] = [];
    for (const [i, input] of inputs.entries()) {
      results.push(await masterGraphRepository.resolveForImport(tx, input, optsFor?.(input, i)));
    }
    return results;
  },
};
