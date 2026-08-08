// masterSignalsRepository.ts — Layer-0 data access for the canonical signal store (migration 0103).
// Always called inside withErTx (leadwolf_er): system-owned tables, no RLS predicate possible, no tenant GUCs.
// Caller owns the transaction, exactly like masterGraphRepository / masterTechnologyRepository.
//
// ── THE PII GUARD IS THE POINT OF THIS FILE ──────────────────────────────────────────────────────────────
// 04-validation.md Part 3 states two hard requirements before person-subject signals are populated:
//   (1) master_signals.payload carries NO contact values, ever — same rule as provenance_event.payload;
//   (2) person-subject signals join the DSAR erasure fan-out.
// It also says, verbatim, that (1) "needs an itest, not a comment".
//
// A comment cannot enforce it and a CHECK constraint cannot express it, so the rule lives here as executable
// code on the only write path: `assertNoContactValues` runs on every recordSignal and THROWS. The function is
// pure and exported precisely so it is unit-testable without a database — the guard is verified even where
// Postgres is not available, and the itest then only has to prove the repository calls it.
//
// Why this matters more than it looks: a signal store that accumulates contact values becomes a SECOND
// cleartext PII store, with none of master_emails/master_phones' encryption, HMAC blind-index dedup, or
// suppression wiring — and nothing would notice, because it would arrive one convenient payload field at a
// time. `{"new_employer_email": "..."}` on a job_change signal is the exact shape of that mistake.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Keys that must never appear in a signal payload, matched case-insensitively after stripping separators.
 *  Key-name matching catches the mistake BEFORE the value arrives — an empty or placeholder
 *  `contact_email` field is still a schema heading in the wrong direction. */
const FORBIDDEN_KEY_TOKENS = [
  "email",
  "phone",
  "mobile",
  "telephone",
  "tel",
  "fax",
  "msisdn",
  "directdial",
];

/** A pragmatic email shape. Deliberately loose on the local part and strict about the `@domain.tld` tail,
 *  because the goal is catching a real address that slipped in, not validating RFC 5322. */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/** E.164 after separator stripping: a leading + and 8-15 digits.
 *  NOT a generic "long run of digits" test — that would reject `amount_minor: 5000000000`, which is a
 *  legitimate funding amount and exactly the kind of false positive that gets a guard disabled. */
const E164_RE = /^\+\d{8,15}$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function looksLikePhone(value: string): boolean {
  const stripped = value.replace(/[\s()\-.]/g, "");
  return E164_RE.test(stripped);
}

/** Where in the payload the offending value sits — so the error names the field instead of the whole object. */
export interface ContactValueViolation {
  path: string;
  reason: "forbidden_key" | "email_value" | "phone_value";
}

/**
 * Find every contact-shaped key or value anywhere in a signal payload. Recurses through nested objects and
 * arrays, because the mistake is just as easy to make two levels down.
 *
 * Pure and exported for unit testing — the guard is the compliance control, so it is verified directly
 * rather than only through the repository that calls it.
 */
export function findContactValues(payload: unknown, path = "payload"): ContactValueViolation[] {
  const found: ContactValueViolation[] = [];

  if (typeof payload === "string") {
    if (EMAIL_RE.test(payload)) found.push({ path, reason: "email_value" });
    else if (looksLikePhone(payload)) found.push({ path, reason: "phone_value" });
    return found;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => found.push(...findContactValues(item, `${path}[${i}]`)));
    return found;
  }

  if (payload !== null && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const norm = normalizeKey(key);
      if (FORBIDDEN_KEY_TOKENS.some((t) => norm.includes(t))) {
        found.push({ path: `${path}.${key}`, reason: "forbidden_key" });
        // Do NOT descend: the key alone is disqualifying, and reporting the child too would be noise.
        continue;
      }
      found.push(...findContactValues(value, `${path}.${key}`));
    }
  }

  return found;
}

/** Throws when a payload carries anything contact-shaped. Called on every write path — a signal store must
 *  never become a second cleartext PII store. */
export function assertNoContactValues(payload: unknown): void {
  const violations = findContactValues(payload);
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.path} (${v.reason})`).join(", ");
    throw new Error(
      `master_signals.payload must not contain contact values — found: ${detail}. Reference the person by id and read the channel tables through the reveal path instead.`,
    );
  }
}

export interface RecordSignalInput {
  subjectType: "company" | "person";
  subjectId: string;
  typeCode: string;
  /** VALID time — when the event happened. Also the partition key. */
  observedAt: Date;
  headline?: string | null;
  payload?: Record<string, unknown>;
  amountMinor?: number | null;
  currency?: string | null;
  relatedCompanyId?: string | null;
  relatedTechnologyId?: string | null;
  confidence?: number | null;
  sourceName?: string | null;
  evidenceRef?: string | null;
  evidenceUrl?: string | null;
}

/**
 * Append one canonical signal.
 *
 * Idempotency is UPSTREAM, as everywhere else in this pipeline: source_records.content_hash is UNIQUE and
 * unpartitioned, so an identical provider payload never produces a second source_record and therefore never
 * reaches this function twice. When `evidenceRef` is supplied, this checks for an existing signal from the
 * same evidence and returns it rather than appending a duplicate — cheap insurance for the replay case that
 * upstream hash cannot cover (a re-run of a derivation over an already-ingested payload).
 *
 * Note there is deliberately NO unique constraint to lean on: a unique over
 * (subject, type, observed_at) would be expressible (observed_at is the partition key) but wrong — two
 * genuinely distinct signals of the same type can share a day, and a constraint that silently drops the
 * second is worse than a duplicate a human can see.
 */
export async function recordSignal(
  tx: Tx,
  input: RecordSignalInput,
): Promise<{ id: string; duplicate: boolean } | null> {
  const payload = input.payload ?? {};
  assertNoContactValues(payload);
  // The headline is rendered straight into the UI, so it gets the same treatment as the payload.
  if (input.headline) assertNoContactValues(input.headline);

  if (input.evidenceRef) {
    const existing = (await tx.execute(sql`
      SELECT id FROM master_signals
       WHERE evidence_ref = ${input.evidenceRef}
         AND subject_id   = ${input.subjectId}
         AND type_code    = ${input.typeCode}
       LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (existing[0]) return { id: existing[0].id, duplicate: true };
  }

  const inserted = (await tx.execute(sql`
    INSERT INTO master_signals
      (subject_type, subject_id, type_code, headline, payload, amount_minor, currency,
       related_company_id, related_technology_id, confidence, source_name, evidence_ref,
       evidence_url, observed_at)
    VALUES
      (${input.subjectType}, ${input.subjectId}, ${input.typeCode}, ${input.headline ?? null},
       ${JSON.stringify(payload)}::jsonb, ${input.amountMinor ?? null}, ${input.currency ?? null},
       ${input.relatedCompanyId ?? null}, ${input.relatedTechnologyId ?? null},
       ${input.confidence ?? null}, ${input.sourceName ?? null}, ${input.evidenceRef ?? null},
       ${input.evidenceUrl ?? null}, ${input.observedAt.toISOString()}::timestamptz)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return inserted[0] ? { id: inserted[0].id, duplicate: false } : null;
}

export interface SignalRow {
  id: string;
  typeCode: string;
  family: string;
  label: string;
  headline: string | null;
  observedAt: Date;
  confidence: string | null;
  evidenceUrl: string | null;
}

/** The profile timeline: one subject's signals, newest first. Joins the vocabulary so the caller renders a
 *  label and a family without a second query or a hard-coded map. */
export async function listSubjectSignals(
  tx: Tx,
  subjectType: "company" | "person",
  subjectId: string,
  limit = 50,
): Promise<SignalRow[]> {
  const rows = (await tx.execute(sql`
    SELECT s.id, s.type_code, t.family, t.label, s.headline, s.observed_at, s.confidence, s.evidence_url
      FROM master_signals s
      JOIN master_signal_types t ON t.code = s.type_code
     WHERE s.subject_type = ${subjectType}
       AND s.subject_id   = ${subjectId}
       AND t.is_enabled
     ORDER BY s.observed_at DESC
     LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    type_code: string;
    family: string;
    label: string;
    headline: string | null;
    observed_at: Date;
    confidence: string | null;
    evidence_url: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    typeCode: r.type_code,
    family: r.family,
    label: r.label,
    headline: r.headline,
    observedAt: r.observed_at,
    confidence: r.confidence,
    evidenceUrl: r.evidence_url,
  }));
}

/**
 * DSAR ERASURE FAN-OUT — 04-validation.md Part 3, requirement 2.
 *
 * A `job_change` or `exec_departed` signal names a person and dates their career, which is PERSONAL DATA
 * even though the payload holds no contact value. Leaving those rows behind after an erasure request is a
 * compliance failure, and a brand-new table is exactly what a fan-out quietly misses.
 *
 * Two directions, both required:
 *   • signals ABOUT the person (subject_type='person'), and
 *   • signals that merely REFERENCE them — none today, but `related_*` is where that would creep in, so the
 *     count is returned per direction to make a future gap visible rather than silently zero.
 *
 * Returns the number of rows deleted rather than a boolean: per this codebase's RLS-denial discipline a
 * caller must assert "removed exactly N", and per 09-compliance the right to erasure BEATS the append-only
 * principle for personal data — so this is a real DELETE, not a tombstone.
 *
 * ⚠ THIS ONE IS **NOT** A withErTx CALL. Every other function in this file runs as leadwolf_er, which is
 * granted SELECT/INSERT/UPDATE on the Layer-0 tables and deliberately **no DELETE** — applyMigrations states
 * the rule directly: "NO DELETE (deletion is the audited DSAR fan-out on the owner/withPrivilegedTx path)".
 * Calling this under withErTx fails with a permission error, which is the correct outcome: erasure is an
 * audited privileged operation, not something an ingest path can reach.
 */
/*
 * NOTE ON THE ACTUAL DSAR CALLER. The erasure fan-out does NOT come through here: it deletes person-subject
 * signals in BULK inside `dsarRepository.suppressMasterPersons`, in the same privileged transaction as
 * master_emails/master_phones, so a partial erasure cannot commit. This single-subject form remains the
 * documented API for a targeted erasure and is what the isolation itest asserts leadwolf_er cannot perform.
 * Keep both in step: a change to what "erase this person's signals" means has to land in both places.
 */
export async function erasePersonSignals(tx: Tx, masterPersonId: string): Promise<number> {
  const deleted = (await tx.execute(sql`
    DELETE FROM master_signals
     WHERE subject_type = 'person'
       AND subject_id   = ${masterPersonId}
     RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return deleted.length;
}

export const masterSignalsRepository = {
  recordSignal,
  listSubjectSignals,
  erasePersonSignals,
  assertNoContactValues,
  findContactValues,
};
