// compareRecords.ts — the pure COMPARISON layer for I5 probabilistic ER. Maps a candidate PERSON record PAIR to a
// FieldObservation[] the Fellegi-Sunter scorer consumes: exact comparisons for the strong keys (LinkedIn id, email
// + phone BLIND INDEX — opaque HMAC hex, never plaintext PII), a fuzzy Jaro-Winkler comparison for the name (the
// fuzzy_name_company method, 03 §5.1), and casefolded-exact for company / title / seniority. Each field resolves to
// agree | disagree | not_compared (a null on either side ⇒ not_compared ⇒ contributes 0 evidence). PURE: no DB, no
// I/O; the candidate generator (blocking) and the shadow writer are later slices. The m/u weights are a documented
// PLACEHOLDER — calibrate on a labelled set (roadmap I5 FP/FN test) before any threshold is trusted for real merges.

import type { FieldObservation, FieldWeights } from "./fellegiSunter.ts";
import { jaroWinkler } from "./stringSimilarity.ts";

/**
 * A normalized, comparison-ready view of a person record — projected from master_persons + its channel tables, or
 * from a source_record's match_keys. PII (email/phone) is present ONLY as blind-index HEX (the HMAC), so comparison
 * never touches plaintext. Any field may be absent (null/undefined) ⇒ that field is not compared.
 */
export interface ComparablePerson {
  linkedinPublicId?: string | null;
  emailBlindIndexHex?: string | null;
  phoneBlindIndexHex?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyId?: string | null;
  companyDomain?: string | null;
  jobTitle?: string | null;
  seniorityLevel?: string | null;
}

/** PLACEHOLDER m/u per field (strongest key → weakest). Calibrate on a labelled set — roadmap I5. */
export const DEFAULT_FIELD_WEIGHTS: Record<string, FieldWeights> = {
  linkedin: { m: 0.95, u: 0.0001 },
  email: { m: 0.9, u: 0.0005 },
  phone: { m: 0.85, u: 0.002 },
  name: { m: 0.9, u: 0.02 },
  company: { m: 0.8, u: 0.05 },
  title: { m: 0.6, u: 0.1 },
  seniority: { m: 0.7, u: 0.2 },
};

// Jaro-Winkler thresholds discretizing name similarity. The ambiguous mid-band is `not_compared` (no evidence)
// rather than a forced agree/disagree — a middling name match should not, by itself, push the score either way.
const NAME_AGREE = 0.92;
const NAME_DISAGREE = 0.7;

type Comparison = "agree" | "disagree" | "not_compared";

/** Exact comparison of two opaque/normalized keys (blind-index hex, ids). not_compared when either is absent. */
function exact(a?: string | null, b?: string | null): Comparison {
  if (!a || !b) return "not_compared";
  return a === b ? "agree" : "disagree";
}

/** Casefolded/trimmed exact comparison (domain, title, seniority). not_compared when either is absent. */
function exactCI(a?: string | null, b?: string | null): Comparison {
  if (!a || !b) return "not_compared";
  return a.trim().toLowerCase() === b.trim().toLowerCase() ? "agree" : "disagree";
}

/** A casefolded, punctuation-stripped canonical name (fullName, else firstName + lastName). null when absent. */
function canonicalName(p: ComparablePerson): string | null {
  const raw =
    (p.fullName ?? "").trim() || [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  if (!raw) return null;
  const norm = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return norm || null;
}

/** Fuzzy name comparison via Jaro-Winkler; the ambiguous mid-band is not_compared. */
function nameComparison(a: ComparablePerson, b: ComparablePerson): Comparison {
  const na = canonicalName(a);
  const nb = canonicalName(b);
  if (!na || !nb) return "not_compared";
  const sim = jaroWinkler(na, nb);
  if (sim >= NAME_AGREE) return "agree";
  if (sim <= NAME_DISAGREE) return "disagree";
  return "not_compared";
}

/** Company comparison: prefer the master-company id (exact); fall back to the registrable domain (casefolded). */
function companyComparison(a: ComparablePerson, b: ComparablePerson): Comparison {
  const byId = exact(a.companyId, b.companyId);
  if (byId !== "not_compared") return byId;
  return exactCI(a.companyDomain, b.companyDomain);
}

/**
 * Compare two person records into the Fellegi-Sunter observation vector (7 fields, strongest key → weakest). Pure.
 * The result feeds scoreFellegiSunter; a field absent on either side contributes no evidence.
 */
export function compareRecords(
  a: ComparablePerson,
  b: ComparablePerson,
  weights: Record<string, FieldWeights> = DEFAULT_FIELD_WEIGHTS,
): FieldObservation[] {
  return [
    { field: "linkedin", comparison: exact(a.linkedinPublicId, b.linkedinPublicId), weights: weights.linkedin! },
    { field: "email", comparison: exact(a.emailBlindIndexHex, b.emailBlindIndexHex), weights: weights.email! },
    { field: "phone", comparison: exact(a.phoneBlindIndexHex, b.phoneBlindIndexHex), weights: weights.phone! },
    { field: "name", comparison: nameComparison(a, b), weights: weights.name! },
    { field: "company", comparison: companyComparison(a, b), weights: weights.company! },
    { field: "title", comparison: exactCI(a.jobTitle, b.jobTitle), weights: weights.title! },
    { field: "seniority", comparison: exactCI(a.seniorityLevel, b.seniorityLevel), weights: weights.seniority! },
  ];
}
