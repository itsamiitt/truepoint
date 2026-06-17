// matchKeys.ts — deterministic match-key normalizers for bulk CSV enrichment. Every uploaded row is reduced
// to canonical keys so the (future) MatchPort can join an arbitrary, sparse external row against our own
// data. Keys map 1:1 onto the match_method ladder (strongest → weakest): deterministic_email →
// deterministic_linkedin → deterministic_phone → deterministic_domain → fuzzy_name_company.
//
// We reuse the existing import normalizers (do NOT reimplement email/domain/linkedin handling) and add only
// what bulk matching needs on top: a Public-Suffix-List registrable domain (eTLD+1) and E.164 phone
// normalization. The normalizers are pure (no IO); buildMatchKeys composes them and additionally derives the
// emailIndex via blindIndex — an HMAC keyed by env.BLIND_INDEX_KEY, so emailIndex is stable for a fixed key
// (the requestHash "normalize before hash" discipline applied to matching), not key-independent.

import { type CountryCode, parsePhoneNumberFromString } from "libphonenumber-js";
import { getDomain } from "tldts";
import { blindIndex } from "../import/blindIndex.ts";
import {
  linkedinPublicIdOf,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "../import/normalize.ts";

/** The match_method any single key satisfies (mirrors the match_method enum, strongest → weakest). */
export type MatchMethod =
  | "deterministic_email"
  | "deterministic_linkedin"
  | "deterministic_phone"
  | "deterministic_domain"
  | "fuzzy_name_company";

/** A sparse external row to be matched: every field is optional and may be empty/dirty. */
export interface MatchInputRow {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  linkedinUrl?: string | null;
  companyDomain?: string | null;
  companyName?: string | null;
  /** Default region (ISO-3166 alpha-2) for parsing national-format phones, e.g. "US". */
  defaultRegion?: CountryCode;
}

/** Lowercased, accent-stripped, punctuation-normalized name plus its token list (for fuzzy blocking). */
export interface CanonicalNameResult {
  canonical: string;
  tokens: string[];
}

/** All normalized keys for one row, consumed by the MatchPort. Absent facets are undefined. */
export interface MatchKeys {
  /** Blind index of the plus-stripped, lowercased email — the deterministic_email key. */
  emailIndex?: Uint8Array;
  /** Registrable domain (eTLD+1) from email/website — the deterministic_domain key. */
  registrableDomain?: string;
  /** E.164 phone — the deterministic_phone key. */
  e164Phone?: string;
  /** LinkedIn public id (slug) — the deterministic_linkedin key. */
  linkedinPublicId?: string;
  /** Canonical name + tokens, combined with a company facet for fuzzy_name_company. */
  name?: CanonicalNameResult;
  /** Canonical company name (lowercased text), the company side of fuzzy_name_company. */
  companyName?: string;
}

// Strip combining diacritical marks after NFKD decomposition, so "José" → "jose". The Unicode `\p{M}`
// (Mark) class with the `u` flag is the lint-safe way to express "any combining mark".
const accentStrip = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "");

/**
 * Registrable / eTLD+1 domain from a URL, email, or raw domain via the Public Suffix List. Handles multi-part
 * suffixes (e.g. `john@mail.corp.co.uk` → `corp.co.uk`). Returns undefined when no registrable domain exists.
 */
export function registrableDomain(input: string | undefined | null): string | undefined {
  const text = normalizeText(input);
  if (!text) return undefined;
  // getDomain pulls the registrable domain straight from an email, a schemed URL with path, or a bare host
  // (case/www/leading-"@" tolerated), so we hand it the raw text. allowPrivateDomains:false → ICANN-only
  // suffixes (e.g. github.io stays the registrable domain rather than being treated as a suffix).
  return getDomain(text, { allowPrivateDomains: false }) ?? undefined;
}

/**
 * Normalize a phone to E.164 (e.g. `+14155552671`) using libphonenumber-js. `defaultRegion` lets a
 * national-format number (no `+` prefix) resolve. Returns null when the input is not a valid number.
 */
export function toE164(
  phone: string | undefined | null,
  defaultRegion?: CountryCode,
): string | null {
  const text = normalizeText(phone);
  if (!text) return null;
  const parsed = parsePhoneNumberFromString(text, defaultRegion);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Canonical person name: lowercased, accent-stripped, punctuation→space, whitespace-collapsed. Prefers an
 * explicit fullName, else joins first+last. Returns undefined when no name material is present.
 */
export function canonicalName(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): CanonicalNameResult | undefined {
  const joined =
    normalizeText(input.fullName) ??
    normalizeText(
      [normalizeText(input.firstName), normalizeText(input.lastName)].filter(Boolean).join(" "),
    );
  if (!joined) return undefined;
  // Keep Unicode letters/numbers (so non-Latin names — CJK, Cyrillic, Arabic — survive); replace punctuation
  // and symbols with a space, then collapse. accentStrip already folded Latin diacritics to base letters.
  const canonical = accentStrip(joined.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!canonical) return undefined;
  return { canonical, tokens: canonical.split(" ") };
}

/** LinkedIn public id (slug) from a profile URL or bare slug — wraps the existing import normalizer. */
export function linkedinPublicId(input: string | undefined | null): string | undefined {
  return linkedinPublicIdOf(input);
}

/**
 * Reduce one sparse row to the full set of deterministic + fuzzy match keys; only facets the row supports
 * are set. Deterministic for a fixed BLIND_INDEX_KEY (which keys emailIndex). The registrable domain prefers
 * the email's domain (most reliable) and falls back to an explicit company website.
 */
export function buildMatchKeys(row: MatchInputRow): MatchKeys {
  const keys: MatchKeys = {};

  const storageEmail = normalizeEmailForStorage(row.email);
  if (storageEmail) {
    keys.emailIndex = blindIndex(normalizeEmailForIndex(storageEmail));
  }

  const domain = registrableDomain(storageEmail ?? row.companyDomain);
  if (domain) keys.registrableDomain = domain;

  const e164 = toE164(row.phone, row.defaultRegion);
  if (e164) keys.e164Phone = e164;

  const slug = linkedinPublicId(row.linkedinUrl);
  if (slug) keys.linkedinPublicId = slug;

  const name = canonicalName(row);
  if (name) keys.name = name;

  const company = normalizeText(row.companyName)?.toLowerCase();
  if (company) keys.companyName = company;

  return keys;
}
