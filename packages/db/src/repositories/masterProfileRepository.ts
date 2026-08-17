// masterProfileRepository.ts — Layer-0 profile/edge/series writers for the linkedin_api landing path
// (docs/planning/linkedin-source-ingestion/). Every function runs under the CALLER's withErTx; none opens a
// transaction, none writes provenance — the caller (core landSourcePayload) owns the full write-set exactly
// as the masterEducationRepository producer contract prescribes: evidence + events + facts, one transaction.
//
// THE FOLD RUNS CORE-SIDE. packages/db cannot import core (dependency direction), so these writers take the
// ALREADY-FOLDED output: the caller reads the row's field_provenance (readPersonForLanding /
// readCompanyForLanding), runs planFieldWrite, and passes back {writableFields → values} plus the merged
// provenance map. The writers apply exactly those columns and stamp the map — nothing here decides what may
// be written, which keeps the pin/user-edit discipline in ONE implementation.
//
// COLUMN ALLOWLISTS ARE CLOSED. Dynamic SET lists are built only from the fixed maps below — a key outside
// the map is ignored, never interpolated, so no caller can smuggle an arbitrary column write through the
// landing path.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Person profile columns the landing may write (camelCase key → column). Closed set: the raw-only fields
 *  (pronoun/premium/open_link/job_seeker/photos) are deliberately ABSENT — adding one is a HUMAN GATE. */
const PERSON_COLUMNS: Readonly<Record<string, string>> = {
  fullName: "full_name",
  firstName: "first_name",
  lastName: "last_name",
  headline: "headline",
  summary: "summary",
  locationRaw: "location_raw",
  jobTitle: "job_title",
  locationCity: "location_city",
  locationCountry: "location_country",
};

/** Company firmographic columns the landing may write. */
const COMPANY_COLUMNS: Readonly<Record<string, string>> = {
  name: "name",
  description: "description",
  industry: "industry",
  websiteUrl: "website_url",
  ownershipType: "ownership_type",
  yearFounded: "year_founded",
  logoUrl: "logo_url",
  backgroundImageUrl: "background_image_url",
  employeeCount: "employee_count",
  revenueMinMinor: "revenue_min_minor",
  revenueMaxMinor: "revenue_max_minor",
  revenueCurrency: "revenue_currency",
  revenueRange: "revenue_range",
  hqCountry: "hq_country",
  hqCity: "hq_city",
};

/** `specialties` is text[] and needs the sql.param single-bind treatment (the recordEducation 22P02 note),
 *  so it is handled apart from the scalar map. */
const COMPANY_ARRAY_COLUMNS: Readonly<Record<string, string>> = {
  specialties: "specialties",
};

export interface PersonLandingRow {
  id: string;
  isSuppressed: boolean;
  fieldProvenance: Record<string, unknown>;
  currentCompanyId: string | null;
  /** The current primary employment edge, when one exists. */
  primaryEmployment: { id: string; masterCompanyId: string | null } | null;
}

export interface CompanyLandingRow {
  id: string;
  fieldProvenance: Record<string, unknown>;
  linkedinCompanyId: string | null;
}

export interface EmploymentStintInput {
  masterPersonId: string;
  masterCompanyId?: string | null;
  companyNameRaw?: string | null;
  /** Must come from the SAME normalizer as master_companies.name_normalized (canonicalName). */
  companyNameNormalized?: string | null;
  title?: string | null;
  location?: string | null;
  description?: string | null;
  isCurrent: boolean;
  startedOn?: string | null; // ISO date; null → the '-infinity' sentinel
  endedOn?: string | null;
  startPrecision?: string | null;
  endPrecision?: string | null;
  assertingSource: string;
  confidence?: number | null;
  observedAt: Date;
}

export interface HeadcountPointInput {
  monthIso: string; // first-of-month ISO date
  jobFunction: string; // '' = whole-company total
  count: number;
}

function buildSet(
  columns: Readonly<Record<string, string>>,
  values: Readonly<Record<string, unknown>>,
): ReturnType<typeof sql.join> | null {
  const parts = Object.entries(values)
    .filter(([key, v]) => v !== undefined && columns[key] !== undefined)
    .map(([key, v]) => sql`${sql.identifier(columns[key]!)} = ${v as string | number | null}`);
  return parts.length > 0 ? sql.join(parts, sql`, `) : null;
}

export const masterProfileRepository = {
  /** Read the person row + its primary edge for the landing fold. Null when the id does not exist. */
  async readPersonForLanding(tx: Tx, masterPersonId: string): Promise<PersonLandingRow | null> {
    const rows = (await tx.execute(sql`
      SELECT p.id, p.is_suppressed, p.field_provenance, p.current_company_id,
             e.id AS primary_employment_id, e.master_company_id AS primary_company_id
        FROM master_persons p
        LEFT JOIN master_employment e
          ON e.master_person_id = p.id AND e.is_primary
       WHERE p.id = ${masterPersonId}
       LIMIT 1
    `)) as unknown as Array<{
      id: string;
      is_suppressed: boolean;
      field_provenance: Record<string, unknown>;
      current_company_id: string | null;
      primary_employment_id: string | null;
      primary_company_id: string | null;
    }>;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      isSuppressed: r.is_suppressed,
      fieldProvenance: r.field_provenance ?? {},
      currentCompanyId: r.current_company_id,
      primaryEmployment: r.primary_employment_id
        ? { id: r.primary_employment_id, masterCompanyId: r.primary_company_id }
        : null,
    };
  },

  async readCompanyForLanding(tx: Tx, masterCompanyId: string): Promise<CompanyLandingRow | null> {
    const rows = (await tx.execute(sql`
      SELECT id, field_provenance, linkedin_company_id
        FROM master_companies WHERE id = ${masterCompanyId} LIMIT 1
    `)) as unknown as Array<{
      id: string;
      field_provenance: Record<string, unknown>;
      linkedin_company_id: string | null;
    }>;
    const r = rows[0];
    return r
      ? {
          id: r.id,
          fieldProvenance: r.field_provenance ?? {},
          linkedinCompanyId: r.linkedin_company_id,
        }
      : null;
  },

  /** Apply the ALREADY-FOLDED person profile write: only allowlisted columns, plus the merged provenance map. */
  async updatePersonProfile(
    tx: Tx,
    masterPersonId: string,
    values: Readonly<Record<string, unknown>>,
    fieldProvenance: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const set = buildSet(PERSON_COLUMNS, values);
    if (!set) return;
    await tx.execute(sql`
      UPDATE master_persons
         SET ${set},
             field_provenance = ${JSON.stringify(fieldProvenance)}::jsonb,
             updated_at = now()
       WHERE id = ${masterPersonId}
    `);
  },

  /** Apply the ALREADY-FOLDED company firmographic write. */
  async updateCompanyProfile(
    tx: Tx,
    masterCompanyId: string,
    values: Readonly<Record<string, unknown>>,
    fieldProvenance: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const scalarSet = buildSet(COMPANY_COLUMNS, values);
    const arrayParts = Object.entries(values)
      .filter(([key, v]) => v !== undefined && COMPANY_ARRAY_COLUMNS[key] !== undefined)
      .map(
        ([key, v]) =>
          sql`${sql.identifier(COMPANY_ARRAY_COLUMNS[key]!)} = ${sql.param(v as string[])}::text[]`,
      );
    const parts = [...(scalarSet ? [scalarSet] : []), ...arrayParts];
    if (parts.length === 0) return;
    await tx.execute(sql`
      UPDATE master_companies
         SET ${sql.join(parts, sql`, `)},
             field_provenance = ${JSON.stringify(fieldProvenance)}::jsonb,
             updated_at = now()
       WHERE id = ${masterCompanyId}
    `);
  },

  /** Fill the hot linkedin_company_id column on a domain-LINKed row that lacks it (dual-write with the
   *  identifier table). Guarded against claiming an id another company already owns; the residual race
   *  aborts the tx on the partial unique and retry converges — the resolver's documented posture. */
  async fillCompanyLinkedinId(
    tx: Tx,
    masterCompanyId: string,
    linkedinCompanyId: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE master_companies
         SET linkedin_company_id = ${linkedinCompanyId}, updated_at = now()
       WHERE id = ${masterCompanyId}
         AND linkedin_company_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM master_companies WHERE linkedin_company_id = ${linkedinCompanyId}
         )
    `);
  },

  /**
   * Upsert one employment stint (mirrors recordEducation's two-conflict-path shape: the resolved and
   * unresolved partial uniques need different targets — a wrong target silently degrades to always-insert).
   * EXCLUDED-first COALESCE: a refetch's fresher facts win where present, existing facts survive where the
   * new payload is silent. Returns the row id, or null when the stint carries no institution at all.
   */
  async upsertEmploymentStint(tx: Tx, input: EmploymentStintInput): Promise<string | null> {
    const startedOn = input.startedOn ?? "-infinity";
    if (input.masterCompanyId) {
      const rows = (await tx.execute(sql`
        INSERT INTO master_employment (
          master_person_id, master_company_id, company_name_raw, company_name_normalized,
          title, location, description, is_current, is_primary,
          started_on, ended_on, start_precision, end_precision,
          asserting_source, match_method, confidence, observed_at
        ) VALUES (
          ${input.masterPersonId}, ${input.masterCompanyId}, ${input.companyNameRaw ?? null},
          ${input.companyNameNormalized ?? null},
          ${input.title ?? null}, ${input.location ?? null}, ${input.description ?? null},
          ${input.isCurrent}, false,
          ${startedOn}, ${input.endedOn ?? null}, ${input.startPrecision ?? null}, ${input.endPrecision ?? null},
          ${input.assertingSource}, ${"deterministic"}, ${input.confidence ?? null}, ${input.observedAt.toISOString()}::timestamptz
        )
        ON CONFLICT (master_person_id, master_company_id, started_on)
        DO UPDATE SET
          title           = COALESCE(EXCLUDED.title, master_employment.title),
          location        = COALESCE(EXCLUDED.location, master_employment.location),
          description     = COALESCE(EXCLUDED.description, master_employment.description),
          -- A PRIMARY row's currency is never flipped by a plain upsert (primary⇒current is CHECK-enforced);
          -- only the promotion path demotes it, atomically with ending the stint.
          is_current      = CASE WHEN master_employment.is_primary
                                 THEN master_employment.is_current
                                 ELSE EXCLUDED.is_current END,
          ended_on        = COALESCE(EXCLUDED.ended_on, master_employment.ended_on),
          end_precision   = COALESCE(EXCLUDED.end_precision, master_employment.end_precision),
          start_precision = COALESCE(EXCLUDED.start_precision, master_employment.start_precision),
          source_count    = master_employment.source_count + 1,
          confidence      = GREATEST(COALESCE(EXCLUDED.confidence, 0), COALESCE(master_employment.confidence, 0)),
          observed_at     = EXCLUDED.observed_at,
          updated_at      = now()
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    }

    if (!input.companyNameNormalized) return null; // employerless — the CHECK would reject it anyway

    const rows = (await tx.execute(sql`
      INSERT INTO master_employment (
        master_person_id, company_name_raw, company_name_normalized,
        title, location, description, is_current, is_primary,
        started_on, ended_on, start_precision, end_precision,
        asserting_source, match_method, confidence, observed_at
      ) VALUES (
        ${input.masterPersonId}, ${input.companyNameRaw ?? null}, ${input.companyNameNormalized},
        ${input.title ?? null}, ${input.location ?? null}, ${input.description ?? null},
        ${input.isCurrent}, false,
        ${startedOn}, ${input.endedOn ?? null}, ${input.startPrecision ?? null}, ${input.endPrecision ?? null},
        ${input.assertingSource}, ${"deterministic"}, ${input.confidence ?? null}, ${input.observedAt.toISOString()}::timestamptz
      )
      ON CONFLICT (master_person_id, company_name_normalized, started_on)
        WHERE master_company_id IS NULL AND company_name_normalized IS NOT NULL
      DO UPDATE SET
        title        = COALESCE(EXCLUDED.title, master_employment.title),
        is_current   = CASE WHEN master_employment.is_primary
                            THEN master_employment.is_current
                            ELSE EXCLUDED.is_current END,
        ended_on     = COALESCE(EXCLUDED.ended_on, master_employment.ended_on),
        source_count = master_employment.source_count + 1,
        observed_at  = EXCLUDED.observed_at,
        updated_at   = now()
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  },

  /**
   * Make `employmentId` the person's ONE primary edge — demote-then-promote, in that order, because
   * uniq_employment_primary would reject a second primary mid-flight. The demoted edge is closed with
   * `endedOn` only when it has no end of its own (a stale payload must not shorten a known stint).
   * Also refreshes the master_persons.current_company_id denormalized cache.
   */
  async promotePrimaryEmployment(
    tx: Tx,
    input: {
      masterPersonId: string;
      employmentId: string;
      masterCompanyId: string | null;
      demotedEndedOn?: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE master_employment
         SET is_primary = false,
             is_current = false,
             ended_on   = COALESCE(ended_on, ${input.demotedEndedOn ?? null}),
             updated_at = now()
       WHERE master_person_id = ${input.masterPersonId}
         AND is_primary
         AND id <> ${input.employmentId}
    `);
    await tx.execute(sql`
      UPDATE master_employment
         SET is_primary = true, is_current = true, updated_at = now()
       WHERE id = ${input.employmentId}
    `);
    await tx.execute(sql`
      UPDATE master_persons
         SET current_company_id = ${input.masterCompanyId}, updated_at = now()
       WHERE id = ${input.masterPersonId}
    `);
  },

  /** Batch-upsert headcount points. The observed_at guard is what makes overlapping 25-month refetches
   *  converge and a stale queued replay a no-op. ≤26 rows per company per fetch — a plain loop is fine. */
  async upsertHeadcountSeries(
    tx: Tx,
    masterCompanyId: string,
    points: readonly HeadcountPointInput[],
    sourceName: string,
    observedAt: Date,
  ): Promise<number> {
    let written = 0;
    for (const p of points) {
      await tx.execute(sql`
        INSERT INTO master_company_headcount
          (master_company_id, month, job_function, employee_count, source_name, observed_at)
        VALUES
          (${masterCompanyId}, ${p.monthIso}, ${p.jobFunction}, ${p.count},
           ${sourceName}, ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (master_company_id, month, job_function)
        DO UPDATE SET
          employee_count = EXCLUDED.employee_count,
          source_name    = EXCLUDED.source_name,
          observed_at    = EXCLUDED.observed_at
        WHERE EXCLUDED.observed_at >= master_company_headcount.observed_at
      `);
      written += 1;
    }
    return written;
  },

  /** Companies due a linkedin_api refresh: LinkedIn-identified, missing this month's totals point. Ordered
   *  stalest-first so a bounded per-tick cap still converges across ticks (no first-run storm — the cap IS
   *  the pacing). */
  async listCompaniesForRefresh(
    tx: Tx,
    limit: number,
  ): Promise<Array<{ id: string; linkedinCompanyId: string }>> {
    const rows = (await tx.execute(sql`
      SELECT c.id, c.linkedin_company_id
        FROM master_companies c
       WHERE c.linkedin_company_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM master_company_headcount h
            WHERE h.master_company_id = c.id
              AND h.job_function = ''
              AND h.month = date_trunc('month', now())::date
         )
       ORDER BY c.updated_at ASC
       LIMIT ${limit}
    `)) as unknown as Array<{ id: string; linkedin_company_id: string }>;
    return rows.map((r) => ({ id: r.id, linkedinCompanyId: r.linkedin_company_id }));
  },

  /** The per-company headcount read: totals series (newest first) — index-only via the 0114 partial index. */
  async listHeadcountTotals(
    tx: Tx,
    masterCompanyId: string,
    limit = 36,
  ): Promise<Array<{ month: string; employeeCount: number }>> {
    const rows = (await tx.execute(sql`
      SELECT month, employee_count
        FROM master_company_headcount
       WHERE master_company_id = ${masterCompanyId} AND job_function = ''
       ORDER BY month DESC
       LIMIT ${limit}
    `)) as unknown as Array<{ month: string; employee_count: number }>;
    return rows.map((r) => ({ month: r.month, employeeCount: r.employee_count }));
  },

  /** The linkedin_company_id of every company this person is employed at — the company-derivation input for
   *  the fetch registry (0118). Reads the resolved employer companies' hot id column; unresolved stints have
   *  no id and are skipped. */
  async listPersonEmployerLinkedinCompanyIds(tx: Tx, masterPersonId: string): Promise<string[]> {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT c.linkedin_company_id AS id
        FROM master_employment e
        JOIN master_companies c ON c.id = e.master_company_id
       WHERE e.master_person_id = ${masterPersonId}
         AND c.linkedin_company_id IS NOT NULL
    `)) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  },

  /** Attach identifier rows (ON CONFLICT DO NOTHING — the global unique is the convergence point). */
  async upsertPersonIdentifiers(
    tx: Tx,
    masterPersonId: string,
    identifiers: ReadonlyArray<{ idType: string; idValue: string }>,
    sourceName: string,
    observedAt: Date,
  ): Promise<void> {
    for (const ident of identifiers) {
      await tx.execute(sql`
        INSERT INTO master_person_identifiers (master_person_id, id_type, id_value, source_name, observed_at)
        VALUES (${masterPersonId}, ${ident.idType}, ${ident.idValue}, ${sourceName}, ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (id_type, id_value) DO NOTHING
      `);
    }
  },

  async upsertCompanyIdentifiers(
    tx: Tx,
    masterCompanyId: string,
    identifiers: ReadonlyArray<{ idType: string; idValue: string }>,
    sourceName: string,
    observedAt: Date,
  ): Promise<void> {
    for (const ident of identifiers) {
      await tx.execute(sql`
        INSERT INTO master_company_identifiers (master_company_id, id_type, id_value, source_name, observed_at)
        VALUES (${masterCompanyId}, ${ident.idType}, ${ident.idValue}, ${sourceName}, ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (id_type, id_value) DO NOTHING
      `);
    }
  },

  /**
   * Contribute one email channel value (0116 multi-channel gate). The GLOBAL blind-index unique is the
   * claim: INSERT ON CONFLICT DO NOTHING → re-SELECT the owner. Own row → corroborate (source_count+1),
   * fill email_enc where the row held only the dedup key (the paid-provider contribution masterGraph.ts's
   * channel notes anticipate), and fill email_type when newly asserted. Another person's row → 'other_owner'
   * (an ER merge signal, not a write) — the same posture as the resolver's email claim.
   */
  async upsertPersonEmail(
    tx: Tx,
    input: {
      masterPersonId: string;
      emailEnc: Uint8Array | null;
      emailBlindIndex: Uint8Array;
      emailDomain: string | null;
      emailType: string | null;
      isPrimary: boolean;
    },
  ): Promise<"landed" | "other_owner"> {
    await tx.execute(sql`
      INSERT INTO master_emails (master_person_id, email_enc, email_blind_index, email_domain, email_type, is_primary)
      VALUES (${input.masterPersonId}, ${input.emailEnc}, ${input.emailBlindIndex},
              ${input.emailDomain}, ${input.emailType}, ${input.isPrimary})
      ON CONFLICT (email_blind_index) DO NOTHING
    `);
    const owner = (await tx.execute(sql`
      SELECT id, master_person_id FROM master_emails
       WHERE email_blind_index = ${input.emailBlindIndex} LIMIT 1
    `)) as unknown as Array<{ id: string; master_person_id: string }>;
    const row = owner[0];
    if (!row) return "landed"; // impossible-race posture mirrors appendSourceRecord
    if (row.master_person_id !== input.masterPersonId) return "other_owner";
    await tx.execute(sql`
      UPDATE master_emails
         SET source_count = source_count + 1,
             email_enc    = COALESCE(email_enc, ${input.emailEnc}),
             email_type   = COALESCE(${input.emailType}, email_type),
             is_primary   = is_primary OR ${input.isPrimary}
       WHERE id = ${row.id} AND master_person_id = ${input.masterPersonId}
    `);
    return "landed";
  },

  /** Contribute one phone channel value — the master_phones twin of upsertPersonEmail. */
  async upsertPersonPhone(
    tx: Tx,
    input: {
      masterPersonId: string;
      phoneEnc: Uint8Array | null;
      phoneBlindIndex: Uint8Array;
      lineType: string | null;
    },
  ): Promise<"landed" | "other_owner"> {
    await tx.execute(sql`
      INSERT INTO master_phones (master_person_id, phone_enc, phone_blind_index, line_type)
      VALUES (${input.masterPersonId}, ${input.phoneEnc}, ${input.phoneBlindIndex}, ${input.lineType})
      ON CONFLICT (phone_blind_index) DO NOTHING
    `);
    const owner = (await tx.execute(sql`
      SELECT id, master_person_id FROM master_phones
       WHERE phone_blind_index = ${input.phoneBlindIndex} LIMIT 1
    `)) as unknown as Array<{ id: string; master_person_id: string }>;
    const row = owner[0];
    if (!row) return "landed";
    if (row.master_person_id !== input.masterPersonId) return "other_owner";
    await tx.execute(sql`
      UPDATE master_phones
         SET source_count = source_count + 1,
             phone_enc    = COALESCE(phone_enc, ${input.phoneEnc}),
             line_type    = COALESCE(${input.lineType}, line_type)
       WHERE id = ${row.id} AND master_person_id = ${input.masterPersonId}
    `);
    return "landed";
  },

  /** Raise the masked-search facets after a channel contribution. TRUE-only — facets are recomputed by the
   *  DSAR fan-out on erasure, never lowered here. */
  async raisePersonChannelFacets(
    tx: Tx,
    masterPersonId: string,
    facets: { hasEmail?: boolean; hasPhone?: boolean },
  ): Promise<void> {
    if (!facets.hasEmail && !facets.hasPhone) return;
    await tx.execute(sql`
      UPDATE master_persons
         SET has_email = has_email OR ${facets.hasEmail === true},
             has_phone = has_phone OR ${facets.hasPhone === true},
             updated_at = now()
       WHERE id = ${masterPersonId}
    `);
  },

  /** The customer read over the 0116 attributes (account-intelligence seam; suppression-safe by
   *  construction: a suppressed subject's rows were DELETED by the DSAR fan-out, so this reads empty). */
  async listPersonSkills(
    tx: Tx,
    masterPersonId: string,
    limit = 100,
  ): Promise<Array<{ skill: string; sourceCount: number }>> {
    const rows = (await tx.execute(sql`
      SELECT skill, source_count FROM master_person_skills
       WHERE master_person_id = ${masterPersonId}
       ORDER BY source_count DESC, skill ASC
       LIMIT ${limit}
    `)) as unknown as Array<{ skill: string; source_count: number }>;
    return rows.map((r) => ({ skill: r.skill, sourceCount: r.source_count }));
  },

  async listPersonLanguages(
    tx: Tx,
    masterPersonId: string,
    limit = 50,
  ): Promise<Array<{ name: string; proficiency: string | null }>> {
    const rows = (await tx.execute(sql`
      SELECT name, proficiency FROM master_person_languages
       WHERE master_person_id = ${masterPersonId}
       ORDER BY name ASC
       LIMIT ${limit}
    `)) as unknown as Array<{ name: string; proficiency: string | null }>;
    return rows.map((r) => ({ name: r.name, proficiency: r.proficiency ?? null }));
  },

  /** Multi-value skills (0116; one row per (person, skill), citext-deduped; re-assert corroborates). */
  async upsertPersonSkills(
    tx: Tx,
    masterPersonId: string,
    skills: readonly string[],
    sourceName: string,
    observedAt: Date,
  ): Promise<void> {
    for (const skill of skills) {
      await tx.execute(sql`
        INSERT INTO master_person_skills (master_person_id, skill, source_name, observed_at)
        VALUES (${masterPersonId}, ${skill}, ${sourceName}, ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (master_person_id, skill)
        DO UPDATE SET source_count = master_person_skills.source_count + 1,
                      observed_at  = EXCLUDED.observed_at
      `);
    }
  },

  /** Multi-value languages (0116). A newly asserted proficiency wins; an absent one preserves the stored. */
  async upsertPersonLanguages(
    tx: Tx,
    masterPersonId: string,
    languages: ReadonlyArray<{ name: string; proficiency: string | null }>,
    sourceName: string,
    observedAt: Date,
  ): Promise<void> {
    for (const lang of languages) {
      await tx.execute(sql`
        INSERT INTO master_person_languages (master_person_id, name, proficiency, source_name, observed_at)
        VALUES (${masterPersonId}, ${lang.name}, ${lang.proficiency}, ${sourceName},
                ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (master_person_id, name)
        DO UPDATE SET proficiency  = COALESCE(EXCLUDED.proficiency, master_person_languages.proficiency),
                      source_count = master_person_languages.source_count + 1,
                      observed_at  = EXCLUDED.observed_at
      `);
    }
  },

  /**
   * LINK-or-MINT a SCHOOL by its legacy numeric LinkedIn school id (a namespace deliberately distinct from
   * linkedin_company_id — see the master_company_identifiers header). The identifier table's global unique
   * is the convergence point: INSERT the school → claim the identifier ON CONFLICT DO NOTHING → re-SELECT
   * the owner; a lost race abandons the just-minted empty row to the deferred ER sweep (the master_emails
   * claim-pattern posture). Mints org_kind='school', name only — the co-op-safe boundary.
   */
  async resolveSchoolByExternalId(
    tx: Tx,
    input: { linkedinSchoolId: string; schoolName: string; sourceName: string; observedAt: Date },
  ): Promise<string> {
    const existing = (await tx.execute(sql`
      SELECT master_company_id FROM master_company_identifiers
       WHERE id_type = 'linkedin_school_id' AND id_value = ${input.linkedinSchoolId} LIMIT 1
    `)) as unknown as Array<{ master_company_id: string }>;
    if (existing[0]) return existing[0].master_company_id;

    const minted = (await tx.execute(sql`
      INSERT INTO master_companies (org_kind, name) VALUES ('school', ${input.schoolName})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const mintedId = minted[0]!.id;
    await tx.execute(sql`
      INSERT INTO master_company_identifiers (master_company_id, id_type, id_value, source_name, observed_at)
      VALUES (${mintedId}, 'linkedin_school_id', ${input.linkedinSchoolId}, ${input.sourceName},
              ${input.observedAt.toISOString()}::timestamptz)
      ON CONFLICT (id_type, id_value) DO NOTHING
    `);
    const owner = (await tx.execute(sql`
      SELECT master_company_id FROM master_company_identifiers
       WHERE id_type = 'linkedin_school_id' AND id_value = ${input.linkedinSchoolId} LIMIT 1
    `)) as unknown as Array<{ master_company_id: string }>;
    return owner[0]?.master_company_id ?? mintedId;
  },

  /** Upsert the ONE headquarters location (the uniq_master_company_hq partial unique is the target). */
  async upsertCompanyHq(
    tx: Tx,
    masterCompanyId: string,
    hq: {
      addressLine: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    },
    sourceName: string,
    observedAt: Date,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO master_company_locations
        (master_company_id, kind, address_line, city, region, postal_code, source_name, observed_at)
      VALUES
        (${masterCompanyId}, 'hq', ${hq.addressLine}, ${hq.city}, ${hq.region}, ${hq.postalCode},
         ${sourceName}, ${observedAt.toISOString()}::timestamptz)
      ON CONFLICT (master_company_id) WHERE kind = 'hq'
      DO UPDATE SET
        address_line = COALESCE(EXCLUDED.address_line, master_company_locations.address_line),
        city         = COALESCE(EXCLUDED.city, master_company_locations.city),
        region       = COALESCE(EXCLUDED.region, master_company_locations.region),
        postal_code  = COALESCE(EXCLUDED.postal_code, master_company_locations.postal_code),
        source_count = master_company_locations.source_count + 1,
        source_name  = EXCLUDED.source_name,
        observed_at  = EXCLUDED.observed_at
    `);
  },
};
