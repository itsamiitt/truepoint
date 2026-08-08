// masterCompanyDetailRepository.ts — Layer-0 data access for the Group-D completeness tables (migration
// 0104): company locations, company contact points, company funding, and person identifiers.
// Runs inside withErTx (leadwolf_er) like its siblings: system-owned tables, no RLS predicate possible.
//
// ── WHY THE SUPPRESSION CHECK IS A PARAMETER AND NOT A JOIN (verified, not assumed) ──────────────────────
// 04-validation.md Part 3 requires master_company_contact_points to join the suppression check: a "generic"
// mailbox is a claim, not a guarantee, and `info@` is frequently routed to one identifiable person.
//
// It CANNOT be a join from here. suppression_list is an RLS-scoped overlay table in `public`, and
// applyMigrations grants leadwolf_er the Layer-0 tables ONLY — "NO overlay grant (it must never touch
// contacts/accounts)", and it is explicitly NOT BYPASSRLS. A join would fail with a permission error at
// runtime, not at review.
//
// So it follows the pattern masterGraphRepository already established for the contribution gate: the check
// happens on the caller's side, where the tenant/global scope is readable, and the DECISION is carried in.
// The parameter is REQUIRED rather than optional — an optional `suppressed?: boolean` is a check someone
// forgets, and the failure mode is a suppressed individual's address quietly re-entering the graph through
// the company door. Making it required means the type system refuses the call until a decision exists.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/**
 * The caller's suppression verdict for a contact value. Deliberately a record rather than a bare boolean so
 * the call site reads as a decision that was made, and so the reason survives into logs.
 */
export interface SuppressionVerdict {
  /** True when the value matched a suppression row — the write is refused. */
  suppressed: boolean;
  /** Free text for the audit trail when suppressed (e.g. "global:email"). */
  reason?: string;
}

export interface RecordContactPointInput {
  masterCompanyId: string;
  kind: "switchboard" | "generic_email" | "fax";
  /** E.164 for phones, lowercased for email. */
  valueNormalized: string;
  /** HMAC over the normalized value, using the SAME key and derivation as master_emails.email_blind_index —
   *  otherwise the two never match and suppression silently misses. Nullable until Phase 6 wires the HMAC. */
  valueBlindIndex?: Uint8Array | null;
  sourceName?: string | null;
  confidence?: number | null;
}

/**
 * Record a company contact point, refusing the write when the caller's verdict says the value is suppressed.
 *
 * Returns null on suppression rather than throwing: a suppressed value arriving from a provider feed is a
 * NORMAL event, not an exceptional one, and a throw here would abort a batch that is otherwise fine. The
 * caller counts the nulls.
 *
 * Convergent under concurrency via the (company, kind, value) unique + ON CONFLICT DO NOTHING, then a
 * re-SELECT — the same idiom masterGraphRepository uses.
 */
export async function recordCompanyContactPoint(
  tx: Tx,
  input: RecordContactPointInput,
  verdict: SuppressionVerdict,
): Promise<{ id: string; suppressed: boolean } | null> {
  if (verdict.suppressed) {
    return null;
  }

  await tx.execute(sql`
    INSERT INTO master_company_contact_points
      (master_company_id, kind, value_normalized, value_blind_index, source_name, confidence)
    VALUES
      (${input.masterCompanyId}, ${input.kind}, ${input.valueNormalized},
       ${input.valueBlindIndex ?? null}, ${input.sourceName ?? null}, ${input.confidence ?? null})
    ON CONFLICT DO NOTHING
  `);

  const row = (await tx.execute(sql`
    SELECT id FROM master_company_contact_points
     WHERE master_company_id = ${input.masterCompanyId}
       AND kind              = ${input.kind}
       AND value_normalized  = ${input.valueNormalized}
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;

  return row[0] ? { id: row[0].id, suppressed: false } : null;
}

export interface UpsertLocationInput {
  masterCompanyId: string;
  kind: "hq" | "office" | "plant" | "registered";
  addressLine?: string | null;
  city?: string | null;
  region?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
  sourceName?: string | null;
  confidence?: number | null;
  observedAt?: Date | null;
}

/**
 * Upsert a company location.
 *
 * The HQ case is special and the schema enforces it: `uniq_master_company_hq` is a partial unique allowing at
 * most one `kind='hq'` per company, because two sources disagreeing about the headquarters is a survivorship
 * problem to RESOLVE, not two rows to keep. So an incoming HQ UPDATEs the existing one rather than inserting
 * a second and hitting the constraint; every other kind is additive.
 *
 * Returns null when nothing was written, which for a non-HQ kind means the row already existed identically.
 */
export async function upsertCompanyLocation(
  tx: Tx,
  input: UpsertLocationInput,
): Promise<{ id: string; replaced: boolean } | null> {
  if (input.kind === "hq") {
    const updated = (await tx.execute(sql`
      UPDATE master_company_locations
         SET address_line = ${input.addressLine ?? null},
             city         = ${input.city ?? null},
             region       = ${input.region ?? null},
             country_code = ${input.countryCode ?? null},
             postal_code  = ${input.postalCode ?? null},
             source_count = source_count + 1,
             confidence   = COALESCE(${input.confidence ?? null}, confidence),
             observed_at  = GREATEST(COALESCE(observed_at, ${input.observedAt ?? null}),
                                     COALESCE(${input.observedAt ?? null}, observed_at))
       WHERE master_company_id = ${input.masterCompanyId}
         AND kind = 'hq'
       RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (updated[0]) return { id: updated[0].id, replaced: true };
  }

  const inserted = (await tx.execute(sql`
    INSERT INTO master_company_locations
      (master_company_id, kind, address_line, city, region, country_code, postal_code,
       source_name, confidence, observed_at)
    VALUES
      (${input.masterCompanyId}, ${input.kind}, ${input.addressLine ?? null}, ${input.city ?? null},
       ${input.region ?? null}, ${input.countryCode ?? null}, ${input.postalCode ?? null},
       ${input.sourceName ?? null}, ${input.confidence ?? null}, ${input.observedAt ?? null})
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return inserted[0] ? { id: inserted[0].id, replaced: false } : null;
}

export interface RecordIdentifierInput {
  masterPersonId: string;
  /** linkedin_public_id | linkedin_urn | github_login | provider:<name> | … Free-form on purpose: the set of
   *  sources is the part most expected to grow, and a closed enum would make each new provider a migration. */
  idType: string;
  idValue: string;
  sourceName?: string | null;
  observedAt?: Date | null;
}

export type RecordIdentifierResult =
  | { status: "created"; id: string }
  | { status: "existing"; id: string }
  /** The identifier is already claimed by a DIFFERENT person — an ER merge candidate, not an error. */
  | { status: "conflict"; heldByPersonId: string };

/**
 * Record an external identifier for a person.
 *
 * `uniq_master_person_identifier` is GLOBAL on (id_type, id_value) — that is what makes this table an ER join
 * key rather than a bag of strings.
 *
 * THE CONFLICT CASE IS THE INTERESTING ONE, and it is why this does not simply
 * `ON CONFLICT DO NOTHING`. If the identifier is already held by a different master person, that is not a
 * duplicate to swallow — it is *evidence that the two golden records are the same person*, which is exactly
 * the signal entity resolution exists to act on. Swallowing it would discard the strongest merge hint the
 * system can receive. So the conflict is RETURNED, and the caller routes it to the review queue.
 */
export async function recordPersonIdentifier(
  tx: Tx,
  input: RecordIdentifierInput,
): Promise<RecordIdentifierResult> {
  const existing = (await tx.execute(sql`
    SELECT id, master_person_id FROM master_person_identifiers
     WHERE id_type = ${input.idType} AND id_value = ${input.idValue}
     LIMIT 1
  `)) as unknown as Array<{ id: string; master_person_id: string }>;

  if (existing[0]) {
    return existing[0].master_person_id === input.masterPersonId
      ? { status: "existing", id: existing[0].id }
      : { status: "conflict", heldByPersonId: existing[0].master_person_id };
  }

  const inserted = (await tx.execute(sql`
    INSERT INTO master_person_identifiers
      (master_person_id, id_type, id_value, source_name, observed_at)
    VALUES
      (${input.masterPersonId}, ${input.idType}, ${input.idValue}, ${input.sourceName ?? null},
       ${input.observedAt ?? null})
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  if (inserted[0]) return { status: "created", id: inserted[0].id };

  // Lost a race between the SELECT and the INSERT: another transaction claimed it. Re-read to find out
  // whether it landed on us or on someone else — the conflict signal must survive the race, not be reported
  // as a generic failure.
  const after = (await tx.execute(sql`
    SELECT id, master_person_id FROM master_person_identifiers
     WHERE id_type = ${input.idType} AND id_value = ${input.idValue}
     LIMIT 1
  `)) as unknown as Array<{ id: string; master_person_id: string }>;

  if (!after[0]) {
    // Neither inserted nor present — should be unreachable; surfacing it beats returning a fake success.
    throw new Error(
      `recordPersonIdentifier: ${input.idType} could not be inserted and is not present after conflict`,
    );
  }
  return after[0].master_person_id === input.masterPersonId
    ? { status: "existing", id: after[0].id }
    : { status: "conflict", heldByPersonId: after[0].master_person_id };
}

export interface RecordFundingInput {
  masterCompanyId: string;
  roundType?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  announcedOn?: string | null;
  leadInvestorCompanyId?: string | null;
  sourceName?: string | null;
  confidence?: number | null;
  evidenceUrl?: string | null;
}

/**
 * Record a funding round — the STRUCTURED FACT. The matching dated EVENT is a separate `master_signals` row
 * of family='funding'; both are kept on purpose, because the profile reads the fact ("total raised, last
 * round") and the feed reads the event ("who raised this month"), and neither should have to reshape the
 * other's data.
 *
 * Dedup is best-effort and the caller must not assume otherwise: `uniq_master_company_funding_round` covers
 * (company, round_type, announced_on), and BOTH of those columns are nullable — Postgres treats NULLs as
 * distinct, so two "unknown round" rows for one company will not collide. Recorded here as well as in the
 * migration because this is the layer that would paper over it.
 */
export async function recordCompanyFunding(
  tx: Tx,
  input: RecordFundingInput,
): Promise<{ id: string } | null> {
  const inserted = (await tx.execute(sql`
    INSERT INTO master_company_funding
      (master_company_id, round_type, amount_minor, currency, announced_on,
       lead_investor_company_id, source_name, confidence, evidence_url)
    VALUES
      (${input.masterCompanyId}, ${input.roundType ?? null}, ${input.amountMinor ?? null},
       ${input.currency ?? null}, ${input.announcedOn ?? null}, ${input.leadInvestorCompanyId ?? null},
       ${input.sourceName ?? null}, ${input.confidence ?? null}, ${input.evidenceUrl ?? null})
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return inserted[0] ? { id: inserted[0].id } : null;
}

export const masterCompanyDetailRepository = {
  recordCompanyContactPoint,
  upsertCompanyLocation,
  recordPersonIdentifier,
  recordCompanyFunding,
};
