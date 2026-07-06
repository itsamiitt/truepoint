// countryToIso.ts — the S-A3 best-effort freetext-country → ISO-3166-1 alpha-2 mapper
// (import-and-data-model-redesign 06 §3/§4: "the backfill maps known names → codes best-effort, leaving
// `country` NULL where unmappable rather than guessing"). The flat accounts.hq_country is varchar(100) freetext
// ("United States") while account_locations.country is char(2) ISO alpha-2 — this closes that gap HONESTLY:
// a confident match returns the code; anything else returns null (counted, never guessed). Deliberately a
// SMALL curated table (common names + a few high-frequency aliases), NOT an exhaustive gazetteer — the honest
// posture is "map what we are sure of, NULL the rest" (the S-CH2 countryHintOf discipline: never guess).
//
// Two confident inputs:
//   • an already-ISO 2-letter code ("US", "gb")           → uppercased, validated A–Z only;
//   • a known country name / common alias ("united states") → the table (case/space/punctuation-insensitive).
// Everything else (ambiguous, misspelled, region-only, empty) → null.

/** Normalize a freetext country cell for lookup: lowercase, collapse whitespace, strip surrounding
 *  punctuation/periods, trim. NOT a data normalizer of a stored value — a lookup key only. */
function normKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Curated name/alias → ISO alpha-2. Keys are normKey() forms. Kept intentionally bounded (06 §3 honesty).
const NAME_TO_ISO: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  canada: "CA",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  peru: "PE",
  ireland: "IE",
  france: "FR",
  germany: "DE",
  deutschland: "DE",
  spain: "ES",
  espana: "ES",
  portugal: "PT",
  italy: "IT",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  belgium: "BE",
  luxembourg: "LU",
  switzerland: "CH",
  austria: "AT",
  poland: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  slovakia: "SK",
  hungary: "HU",
  romania: "RO",
  bulgaria: "BG",
  greece: "GR",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  iceland: "IS",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  ukraine: "UA",
  russia: "RU",
  "russian federation": "RU",
  turkey: "TR",
  turkiye: "TR",
  israel: "IL",
  "united arab emirates": "AE",
  uae: "AE",
  "saudi arabia": "SA",
  qatar: "QA",
  kuwait: "KW",
  bahrain: "BH",
  oman: "OM",
  egypt: "EG",
  "south africa": "ZA",
  nigeria: "NG",
  kenya: "KE",
  ghana: "GH",
  morocco: "MA",
  india: "IN",
  pakistan: "PK",
  bangladesh: "BD",
  "sri lanka": "LK",
  china: "CN",
  "people's republic of china": "CN",
  "hong kong": "HK",
  taiwan: "TW",
  japan: "JP",
  "south korea": "KR",
  "republic of korea": "KR",
  korea: "KR",
  singapore: "SG",
  malaysia: "MY",
  indonesia: "ID",
  thailand: "TH",
  vietnam: "VN",
  philippines: "PH",
  "the philippines": "PH",
  australia: "AU",
  "new zealand": "NZ",
};

// A tiny valid-ISO set for the "already a code" fast path — only the codes that appear above (so an arbitrary
// 2-letter token that is NOT a country code, e.g. "OK" or "NA" the freetext, is rejected rather than trusted).
const KNOWN_ISO = new Set(Object.values(NAME_TO_ISO));

/**
 * Map a freetext hq_country to ISO alpha-2, or null when not confidently mappable (06 §3 honesty).
 * @returns the uppercase alpha-2 code, or null (unmappable → the location's `country` stays NULL, counted).
 */
export function countryToIso(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const key = normKey(raw);
  if (key === "") return null;
  // Name / alias table FIRST — so 2-letter aliases ("uk" → GB, "us" → US) resolve correctly before the
  // already-a-code fast path (which would otherwise map "uk" → "UK", not a real code, and drop it).
  const named = NAME_TO_ISO[key];
  if (named) return named;
  // Already a 2-letter token? Trust it ONLY when it is a code we know maps to a real country above — an
  // unknown 2-letter freetext ("na", "ok") is rejected, never blind-trusted as ISO.
  if (/^[a-z]{2}$/.test(key)) {
    const up = key.toUpperCase();
    return KNOWN_ISO.has(up) ? up : null;
  }
  return null;
}
