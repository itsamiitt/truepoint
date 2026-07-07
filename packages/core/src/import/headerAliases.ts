// headerAliases.ts — the server-side auto-map ALIAS TABLE + proposal (import-redesign 08 §3.2, S-I8).
// On draft upload the server proposes a mapping: header text normalized (case/punctuation/whitespace —
// the Salesforce matching posture, 03 §1.1 [68][31]) and matched against the canonical field names + this
// alias table, seeded with the common vendor headers (HubSpot/Salesforce/ZoomInfo/Apollo-style exports —
// 03 §1.1/§1.3). The result is strictly BINARY mapped/unmapped per column with client-side override —
// **no confidence percentages** (03 §1.3: no vendor shows them; binary + override is parity). Duplicate
// headers (two columns normalizing to the same key) are NEVER auto-picked — auto-map refuses to guess
// between them, both stay unmapped until the user chooses (08 §Edge cases `duplicate_header`).
//
// Deliberately NOT covered here (deferred rungs of 08 §3.2, recorded in doc 16):
//   (b) workspace custom-field registry keys/labels — needs a DB read; the wizard's "+ Create field" flow
//       uses the EXISTING typed registry endpoint (apps/api features/custom-fields POST — ADR-0028); this
//       module stays pure/DB-free (16 §1).
//   (c) multi-value channel slots (mobile_phone → phone type mobile …) — the 05 §6 slot vocabulary is
//       unshipped (contact_emails/contact_phones 🔲); the single `phone`/`email` canonicals absorb the
//       common slot headers meanwhile.
//   (d) sampled-value type inference as a tiebreaker — a later polish; alias matching alone covers the
//       vendor-header corpus this table seeds.
// The web wizard's client-side autoMapHeaders (ImportWizard.tsx, S-U4) is the label-only predecessor; the
// server proposal is a strict superset and the client pre-fills from it when the draft flow is on.

import type { CanonicalField, ColumnMapping } from "@leadwolf/types";

/** Normalize a header/label for alias matching: lowercase, strip everything but a–z0–9 — so "First Name",
 *  "first_name", " FIRSTNAME " and "First-Name" all collapse to one key (mirrors the web wizard's
 *  normalizeKey so client and server can never disagree on a match). */
export function normalizeHeaderKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Canonical field → NORMALIZED alias keys, most-specific first (the first alias that uniquely matches a
 * header wins for that field; each header is consumed once). The first entry of every list is the field's
 * own normalized name, so an export produced FROM TruePoint always round-trips. Field order below is the
 * assignment precedence when two fields could claim the same header (e.g. `email` claims "Email" before
 * any later rung sees it) — identity keys first, then person, then account (mirrors the ladder's primacy).
 */
const HEADER_ALIASES: Readonly<Record<CanonicalField, readonly string[]>> = {
  // Identity keys first (04 §2 precedence: email → linkedin → sales-nav).
  email: [
    "email",
    "emailaddress",
    "workemail",
    "businessemail",
    "primaryemail",
    "emailid",
    "contactemail",
  ],
  linkedinUrl: [
    "linkedinurl",
    "linkedin",
    "linkedinprofile",
    "linkedinprofileurl",
    "personlinkedinurl",
    "linkedincontactprofileurl",
  ],
  linkedinPublicId: ["linkedinpublicid", "linkedinid", "linkedinhandle", "publicid"],
  salesNavProfileUrl: [
    "salesnavprofileurl",
    "salesnavigatorprofileurl",
    "salesnavigatorurl",
    "salesnavurl",
  ],
  salesNavLeadId: ["salesnavleadid", "salesnavigatorleadid", "leadid"],
  // Person fields.
  firstName: ["firstname", "first", "givenname", "forename"],
  lastName: ["lastname", "last", "surname", "familyname"],
  jobTitle: ["jobtitle", "title", "position", "role", "designation"],
  seniorityLevel: ["senioritylevel", "seniority", "managementlevel"],
  department: ["department", "dept", "jobfunction", "function"],
  phone: [
    "phone",
    "phonenumber",
    "mobilephone",
    "mobile",
    "directphone",
    "workphone",
    "telephone",
    "cellphone",
    "contactphone",
  ],
  locationCity: ["locationcity", "city", "town", "locality"],
  locationCountry: ["locationcountry", "country", "countryregion"],
  // Account fields.
  accountName: [
    "accountname",
    "company",
    "companyname",
    "organization",
    "organisation",
    "employer",
    "currentcompany",
    "account",
  ],
  accountDomain: [
    "accountdomain",
    "domain",
    "companydomain",
    "website",
    "companywebsite",
    "websiteurl",
    "webdomain",
  ],
  // P5 delta imports (08 §9 layer 3): the caller's stable external key. SPECIFIC aliases only — deliberately
  // NO bare "id" (a generic id column must never auto-claim the external key; a stray external-id mapping with
  // the delta gate on would silently change dedup precedence). Auto-mapping it is harmless when the delta gate
  // is off (the field is inert), and the user confirms every mapping regardless (binary + override, 03 §1.3).
  externalId: ["externalid", "externalkey", "externalrecordid", "crmid", "sourceid", "recordid"],
};

/**
 * Propose a ColumnMapping for the parsed header row. Deterministic and pure (same headers → same
 * proposal): fields are visited in HEADER_ALIASES order, aliases within a field most-specific-first,
 * each source header is used at most once, and a normalized key carried by MORE THAN ONE header is
 * skipped entirely (duplicate headers force an explicit user pick — never a guess). Empty/symbol-only
 * headers never match. Returns the shipped header-keyed mapping shape (canonical field → source header).
 */
export function suggestColumnMapping(headers: string[]): ColumnMapping {
  // Normalized key → the DISTINCT headers carrying it (two identical header strings also count as 2 —
  // `mapRow` addresses rows by header string, which cannot disambiguate duplicates).
  const byKey = new Map<string, string[]>();
  for (const header of headers) {
    const key = normalizeHeaderKey(header);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(header);
    else byKey.set(key, [header]);
  }

  const used = new Set<string>();
  const out: ColumnMapping = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
    CanonicalField,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const candidates = byKey.get(alias);
      if (!candidates || candidates.length !== 1) continue; // absent, or duplicated ⇒ no guess
      const header = candidates[0]!;
      if (used.has(header)) continue; // an earlier (higher-precedence) field claimed it
      out[field] = header;
      used.add(header);
      break;
    }
  }
  return out;
}
