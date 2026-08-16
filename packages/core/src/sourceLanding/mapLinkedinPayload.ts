// mapLinkedinPayload.ts — PURE mapping from a validated linkedin_api payload to the landing input
// (docs/planning/linkedin-source-ingestion/). No IO: same payload → same landing input, so the landing
// converges on replay exactly like the folds it feeds.
//
// THE COMPLIANCE BOUNDARY LIVES HERE (2026-08-16 decision, raw-only fields): pronoun, premium, open_link,
// job_seeker, photo URLs, skills, languages and volunteering are DROPPED at this boundary — the structured
// schema never sees them. They survive verbatim in source_records.raw_data (appended by landSourcePayload),
// so the decision is reversible by re-projection the day a HUMAN GATE opens. Do not "complete" this mapper
// by adding them.
//
// Normalizers are the SHARED ones — parsePartialDate (@leadwolf/types), registrableDomain / canonicalName /
// linkedinPublicId (enrichment/matchKeys.ts) — because a second implementation of any of them WILL drift,
// and drifted keys silently split stints/companies (the master_employment.company_name_normalized rule).

import {
  type LinkedinApiCompanyPayload,
  type LinkedinApiEducation,
  type LinkedinApiPersonPayload,
  type LinkedinApiPosition,
  type PartialDatePrecision,
  parsePartialDate,
} from "@leadwolf/types";
import { canonicalName, linkedinPublicId, registrableDomain } from "../enrichment/matchKeys.ts";

/** The source label every descriptor/event/evidence row from this source carries (C-02: never a workspace). */
export const LINKEDIN_API_SOURCE = "linkedin_api";
/** field_provenance `src` for this source's writes. */
export const LINKEDIN_API_PROVENANCE_SRC = `provider:${LINKEDIN_API_SOURCE}`;
/** Static provider confidence for asserted profile scalars (METHOD-prior "provider" class). */
export const LINKEDIN_API_CONFIDENCE = 0.75;
/** Minimum |Δ|/prev over the latest month required to emit a headcount signal — the samples show endless
 *  ±0% months, and an unthresholded emitter would be pure noise. */
export const HEADCOUNT_SIGNAL_MIN_PCT = 0.05;

export interface MappedDate {
  isoDate: string | null; // null = the '-infinity' sentinel ("start unknown")
  precision: PartialDatePrecision | null;
}

export interface MappedPosition {
  linkedinCompanyId: string | null; // decimal string of the numeric id
  companyNameRaw: string | null;
  companyNameNormalized: string | null;
  title: string | null;
  location: string | null;
  description: string | null;
  isCurrent: boolean;
  start: MappedDate;
  end: MappedDate;
}

export interface MappedEducation {
  linkedinSchoolId: string | null;
  schoolNameRaw: string | null;
  schoolNameNormalized: string | null;
  degree: string | null;
  fieldsOfStudy: string[] | null;
  start: MappedDate;
  end: MappedDate;
}

export interface MappedPerson {
  kind: "person";
  /** Resolver match keys (LINK ladder order lives in the resolver, not here). */
  linkedinPublicId: string;
  linkedinMemberUrn: string;
  linkedinMemberId: string | null;
  /** Identifier rows the landing attaches to the resolved person (id_type → id_value). */
  identifiers: Array<{ idType: string; idValue: string }>;
  /** Profile scalars folded via planFieldWrite (keys = master_persons column camelCase). */
  fields: Record<string, string>;
  positions: MappedPosition[];
  /** Index into positions[] of the CURRENT PRIMARY stint (the payload's current_position match), or null. */
  primaryPositionIndex: number | null;
  educations: MappedEducation[];
}

export interface MappedHeadcountPoint {
  monthIso: string; // first-of-month ISO date
  jobFunction: string; // '' = whole-company total
  count: number;
}

export interface MappedCompany {
  kind: "company";
  linkedinCompanyId: string;
  linkedinCompanySlug: string | null;
  /** PSL registrable domain from the payload's website, when one parses. */
  registrableDomain: string | null;
  name: string;
  identifiers: Array<{ idType: string; idValue: string }>;
  /** Firmographic scalars folded via planFieldWrite (keys = master_companies column camelCase). */
  fields: Record<string, string | number | string[]>;
  hq: {
    addressLine: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    countryName: string | null; // free-text country (hq_country column); char(2) mapping is deferred
  } | null;
  headcount: MappedHeadcountPoint[];
}

const OWNERSHIP_MAP: ReadonlyArray<[RegExp, string]> = [
  [/public/i, "public"],
  [/privately|private/i, "private"],
  [/non.?profit/i, "nonprofit"],
  [/government/i, "government"],
  [/partnership/i, "partnership"],
  [/sole.?proprietorship/i, "sole_proprietorship"],
  [/self.?employed/i, "self_employed"],
  [/educational/i, "educational"],
];

/** Normalize the vendor's ownership display string ("Public Company") into the CHECK vocabulary, or null.
 *  Unknown strings map to 'other' — the raw string survives in source_records.raw_data either way. */
export function mapOwnershipType(display: string | null | undefined): string | null {
  const text = display?.trim();
  if (!text) return null;
  for (const [re, value] of OWNERSHIP_MAP) {
    if (re.test(text)) return value;
  }
  return "other";
}

const REVENUE_UNIT: Readonly<Record<string, number>> = {
  THOUSAND: 1_000,
  MILLION: 1_000_000,
  BILLION: 1_000_000_000,
  TRILLION: 1_000_000_000_000,
};

/** amount×unit → minor units (cents). Null on unknown unit or unsafe magnitude — the pair is then dropped. */
export function revenueMinor(
  amount: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (amount == null || unit == null) return null;
  const mult = REVENUE_UNIT[unit.toUpperCase()];
  if (mult === undefined) return null;
  const minor = amount * mult * 100;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Human display for the structured band ("$5M–$10M" for USD; "5M–10M EUR" otherwise), dual-written into
 *  the legacy revenue_range varchar. */
export function revenueDisplay(
  currency: string,
  min: { amount: number; unit: string } | null,
  max: { amount: number; unit: string } | null,
): string | null {
  const code = currency.toUpperCase();
  const usd = code === "USD";
  const fmt = (b: { amount: number; unit: string }): string =>
    `${usd ? "$" : ""}${b.amount}${b.unit[0]?.toUpperCase() ?? ""}`;
  const parts = [min ? fmt(min) : null, max ? fmt(max) : null].filter(Boolean);
  if (parts.length === 0) return null;
  const range = parts.join("–");
  return usd ? range : `${range} ${code}`;
}

function mapDate(raw: string | null | undefined): MappedDate {
  const parsed = parsePartialDate(raw);
  return parsed
    ? { isoDate: parsed.isoDate, precision: parsed.precision }
    : { isoDate: null, precision: null };
}

const trimmed = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
};

function mapPosition(p: LinkedinApiPosition): MappedPosition {
  const nameRaw = trimmed(p.company_name);
  return {
    linkedinCompanyId: p.company_id != null ? String(p.company_id) : null,
    companyNameRaw: nameRaw,
    companyNameNormalized: nameRaw
      ? (canonicalName({ fullName: nameRaw })?.canonical ?? null)
      : null,
    title: trimmed(p.title),
    location: trimmed(p.location),
    description: trimmed(p.description),
    isCurrent: p.is_current === true,
    start: mapDate(p.start_date),
    end: mapDate(p.end_date),
  };
}

function mapEducation(e: LinkedinApiEducation): MappedEducation {
  const nameRaw = trimmed(e.school_name);
  return {
    linkedinSchoolId: e.school_id != null ? String(e.school_id) : null,
    schoolNameRaw: nameRaw,
    schoolNameNormalized: nameRaw
      ? (canonicalName({ fullName: nameRaw })?.canonical ?? null)
      : null,
    degree: trimmed(e.degree),
    fieldsOfStudy:
      Array.isArray(e.fields_of_study) && e.fields_of_study.length > 0
        ? e.fields_of_study.filter((f) => typeof f === "string" && f.trim().length > 0)
        : null,
    start: mapDate(e.start_date),
    end: mapDate(e.end_date),
  };
}

/** Which positions[] entry is the payload's current primary. Prefer the exact current_position match
 *  (company_id + title), else the first is_current entry, else null. */
function primaryIndex(
  payload: LinkedinApiPersonPayload,
  positions: MappedPosition[],
): number | null {
  const cp = payload.current_position;
  if (cp) {
    const cpCompany = cp.company_id != null ? String(cp.company_id) : null;
    const cpTitle = trimmed(cp.title);
    const exact = positions.findIndex(
      (p) => p.isCurrent && p.linkedinCompanyId === cpCompany && p.title === cpTitle,
    );
    if (exact >= 0) return exact;
  }
  const firstCurrent = positions.findIndex((p) => p.isCurrent);
  return firstCurrent >= 0 ? firstCurrent : null;
}

export function mapLinkedinPerson(payload: LinkedinApiPersonPayload): MappedPerson {
  const slug =
    linkedinPublicId(payload.public_identifier) ??
    linkedinPublicId(payload.linkedin_url) ??
    payload.public_identifier;
  const memberId = payload.member_id != null ? String(payload.member_id) : null;

  const fields: Record<string, string> = {};
  const put = (key: string, value: string | null): void => {
    if (value != null) fields[key] = value;
  };
  put("fullName", trimmed(payload.full_name));
  put("firstName", trimmed(payload.first_name));
  put("lastName", trimmed(payload.last_name));
  put("headline", trimmed(payload.headline));
  put("summary", trimmed(payload.summary));
  put("locationRaw", trimmed(payload.location));

  const positions = (payload.positions ?? []).map(mapPosition).filter(
    // A position with no employer identity at all cannot satisfy master_employment_employer_present.
    (p) => p.linkedinCompanyId != null || p.companyNameRaw != null,
  );
  const primary = primaryIndex(payload, positions);
  if (primary != null && positions[primary]?.title) {
    put("jobTitle", positions[primary].title);
  }

  return {
    kind: "person",
    linkedinPublicId: slug,
    linkedinMemberUrn: payload.profile_id,
    linkedinMemberId: memberId,
    identifiers: [
      { idType: "linkedin_public_id", idValue: slug },
      { idType: "linkedin_member_urn", idValue: payload.profile_id },
      ...(memberId ? [{ idType: "linkedin_member_id", idValue: memberId }] : []),
    ],
    fields,
    positions,
    primaryPositionIndex: primary,
    educations: (payload.educations ?? [])
      .map(mapEducation)
      .filter((e) => e.linkedinSchoolId != null || e.schoolNameRaw != null),
  };
}

/** "YYYY-MM" → first-of-month ISO date, or null. */
function monthIso(raw: string | null | undefined): string | null {
  const parsed = parsePartialDate(raw);
  return parsed && parsed.precision !== "day" ? parsed.isoDate : null;
}

export function mapLinkedinCompany(payload: LinkedinApiCompanyPayload): MappedCompany {
  const liId = String(payload.company_id);
  const slug = trimmed(payload.public_identifier);
  const domain = registrableDomain(payload.website) ?? null;

  const fields: Record<string, string | number | string[]> = {};
  const put = (key: string, value: string | number | string[] | null): void => {
    if (value != null && !(Array.isArray(value) && value.length === 0)) fields[key] = value;
  };
  put("name", trimmed(payload.name));
  put("description", trimmed(payload.description));
  put("industry", trimmed(payload.industry));
  put("websiteUrl", trimmed(payload.website));
  put("ownershipType", mapOwnershipType(payload.type));
  put("yearFounded", payload.year_founded ?? null);
  put("specialties", payload.specialties ?? null);
  put("logoUrl", trimmed(payload.logo));
  put("backgroundImageUrl", trimmed(payload.background_picture));
  put("employeeCount", payload.employee_count ?? payload.headcount?.total ?? null);

  const rr = payload.revenue_range;
  if (rr?.currency) {
    const currency = rr.currency.toUpperCase().slice(0, 3);
    const min =
      rr.min?.amount != null && rr.min.unit != null
        ? { amount: rr.min.amount, unit: rr.min.unit }
        : null;
    const max =
      rr.max?.amount != null && rr.max.unit != null
        ? { amount: rr.max.amount, unit: rr.max.unit }
        : null;
    const minMinor = min ? revenueMinor(min.amount, min.unit) : null;
    const maxMinor = max ? revenueMinor(max.amount, max.unit) : null;
    if (minMinor != null || maxMinor != null) {
      put("revenueCurrency", currency);
      put("revenueMinMinor", minMinor);
      put("revenueMaxMinor", maxMinor);
      put("revenueRange", revenueDisplay(currency, min, max));
    }
  }

  const hqRaw = payload.headquarters;
  const hq =
    hqRaw &&
    (hqRaw.line1 || hqRaw.line2 || hqRaw.city || hqRaw.geographic_area || hqRaw.postal_code)
      ? {
          addressLine:
            trimmed([trimmed(hqRaw.line1), trimmed(hqRaw.line2)].filter(Boolean).join(", ")) ??
            null,
          city: trimmed(hqRaw.city),
          region: trimmed(hqRaw.geographic_area),
          postalCode: trimmed(hqRaw.postal_code),
          countryName: trimmed(hqRaw.country),
        }
      : null;
  if (hq?.countryName) put("hqCountry", hq.countryName);
  if (hq?.city) put("hqCity", hq.city);

  const headcount: MappedHeadcountPoint[] = [];
  for (const point of payload.headcount?.monthly ?? []) {
    const iso = monthIso(point.month);
    if (iso && point.count >= 0)
      headcount.push({ monthIso: iso, jobFunction: "", count: point.count });
  }
  for (const fn of payload.headcount?.by_function ?? []) {
    const label = trimmed(fn.function);
    if (!label) continue;
    for (const point of fn.monthly ?? []) {
      const iso = monthIso(point.month);
      if (iso && point.count >= 0)
        headcount.push({ monthIso: iso, jobFunction: label.slice(0, 60), count: point.count });
    }
  }

  return {
    kind: "company",
    linkedinCompanyId: liId,
    linkedinCompanySlug: slug,
    registrableDomain: domain,
    name: payload.name,
    identifiers: [
      { idType: "linkedin_company_id", idValue: liId },
      ...(slug ? [{ idType: "linkedin_company_slug", idValue: slug }] : []),
    ],
    fields,
    hq,
    headcount,
  };
}

/** Latest-vs-previous total delta over the mapped series; the signal emitter thresholds on it. */
export function headcountDeltaPct(points: MappedHeadcountPoint[]): {
  fromMonth: string;
  toMonth: string;
  from: number;
  to: number;
  pct: number;
} | null {
  const totals = points
    .filter((p) => p.jobFunction === "")
    .sort((a, b) => a.monthIso.localeCompare(b.monthIso));
  if (totals.length < 2) return null;
  const prev = totals[totals.length - 2]!;
  const latest = totals[totals.length - 1]!;
  if (prev.count <= 0) return null;
  return {
    fromMonth: prev.monthIso,
    toMonth: latest.monthIso,
    from: prev.count,
    to: latest.count,
    pct: (latest.count - prev.count) / prev.count,
  };
}
