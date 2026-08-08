// blocking.ts — the CANDIDATE GENERATOR both sibling modules in this directory describe as "a later slice":
// compareRecords.ts builds the comparison vector for a pair, fellegiSunter.ts scores it, and this decides
// WHICH PAIRS ARE EVER COMPARED. PURE, IO-free, deterministic. The sweep that reads/writes `block_key` and
// `match_links` lives in apps/workers; this is the arithmetic it runs, kept here so it is testable without
// Postgres.
//
// It does NOT re-implement scoring. `scoreFellegiSunter` (fellegiSunter.ts) already exists, is tested, and
// carries the calibrated DEFAULT_FELLEGI_SUNTER_CONFIG; `compareRecords` already builds the vector with
// DEFAULT_FIELD_WEIGHTS. This module produces the keys that decide which pairs reach them.
//
// ── WHY BLOCKING IS THE ENTIRE PROBLEM (01-research.md R5) ───────────────────────────────────────────────
// Comparison count grows with the SQUARE of record count. Splink's own guidance: 1M records implies ~500
// BILLION pairwise comparisons, and even after blocking the surviving count is typically 10x-1000x the input
// row count. The Fellegi-Sunter arithmetic next door is trivial; CANDIDATE GENERATION is the expensive part,
// and it is an index problem, not a new service. Hence no Splink runtime and no Spark.
//
// Two rules this module exists to enforce, both from R5:
//   1. A BLOCKING RULE MUST NOT USE A SIMILARITY FUNCTION. Similarity has to be evaluated across all candidate
//      pairs before it can filter any, which is exactly the quadratic cost blocking was meant to avoid. Every
//      key below is a deterministic string transform: computable per-row, equality-joinable, index-backed by
//      migration 0106. stringSimilarity.ts is for COMPARING a blocked pair, never for forming the block.
//   2. A RECORD WITH TOO LITTLE TO BLOCK ON GETS **NO KEY AT ALL** (null), not a placeholder. A shared
//      "unknown" bucket is the quadratic bomb wearing a block's clothing: every keyless record would compare
//      against every other keyless record. Null means "not a probabilistic candidate this pass" — the
//      deterministic tier still resolves it, and it costs nothing.

/** Every Unicode Mark (Mn/Mc/Me) — what NFD decomposition separates a letter's diacritics into.
 *
 *  `\p{M}` rather than the `[\u0300-\u036f]` range this started as. That range covers only the Latin
 *  Combining Diacritical Marks block, so it silently fails to fold Vietnamese, Devanagari or Arabic marks;
 *  the property escape covers all of them. It is also the form biome's noMisleadingCharacterClass accepts,
 *  because a hand-written range CAN match a lone combining character and so behaves differently than it
 *  reads. Requires the `u` flag. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Unicode-fold a name for keying: decompose, strip combining marks, lowercase, drop everything that is not
 * a-z0-9.
 *
 * The diacritic strip is load-bearing, not cosmetic. "Müller" from one source and "Muller" from another must
 * land in the SAME block or the pair is never even considered — and cross-source spelling drift on accented
 * names is one of the most common real duplicate patterns in European data.
 */
export function foldToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Legal-form suffixes stripped before company keying, so "Acme Ltd" and "Acme Limited" agree. */
const LEGAL_SUFFIXES = [
  "incorporated",
  "inc",
  "corporation",
  "corp",
  "company",
  "co",
  "limited",
  "ltd",
  "llc",
  "llp",
  "lp",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "bv",
  "nv",
  "ab",
  "as",
  "oy",
  "spa",
  "srl",
  "pty",
  "pte",
  "kk",
  "kg",
  "ohg",
  "aps",
  "holdings",
  "holding",
  "group",
];

/**
 * Person blocking key: folded surname + first initial + country.
 *
 * The cheapest key that keeps blocks small while preserving recall on the mistakes that actually happen.
 * Surname alone puts every Smith on earth in one block. Using the first INITIAL rather than the whole
 * forename unifies TRUNCATIONS — "Rob"/"Robert", "Kate"/"Katherine" — which a full-forename key would split
 * into blocks that never meet.
 *
 * KNOWN LIMITATION, proven by a test rather than hidden: it does NOT unify SUBSTITUTED nicknames.
 * "Bob"/"Robert", "Bill"/"William", "Dick"/"Richard" have different initials and therefore land in different
 * blocks, so the probabilistic tier never compares them. Closing that needs a nickname lookup table — real
 * work, deliberately not smuggled in here. The deterministic tier (linkedin id, email/phone blind index,
 * master_person_identifiers) still resolves those pairs, and resolves most of them.
 *
 * Returns null unless there is a usable surname (>= 2 folded characters). R5's recall-over-precision rule
 * applies WITHIN a block; it does not justify manufacturing a block for a record that cannot be keyed.
 */
export function personBlockKey(input: {
  lastName?: string | null;
  firstName?: string | null;
  countryCode?: string | null;
}): string | null {
  const last = foldToken(input.lastName ?? "");
  if (last.length < 2) return null;

  const initial = foldToken(input.firstName ?? "").slice(0, 1) || "_";
  const country = foldToken(input.countryCode ?? "").slice(0, 2) || "__";
  return `p:${last}:${initial}:${country}`;
}

/**
 * Company blocking key: folded name with trailing legal suffixes stripped, plus country.
 *
 * Country is included because the same trading name in two countries is usually two companies, and omitting
 * it would put them in one block AND, downstream, at risk of one match. It is weighted differently for
 * persons, who move countries far more readily than companies do — which is why the two keys differ.
 *
 * Suffixes are stripped from the END only ("Group4 Securities" keeps its leading "group"; "Acme Group" loses
 * its trailing one), and never down to nothing: a name that is ONLY a legal form is a parsing failure, and
 * keying it to a tiny junk block is the safer of the two failures.
 */
export function companyBlockKey(input: {
  name?: string | null;
  countryCode?: string | null;
}): string | null {
  // Not foldToken: this needs the word BOUNDARIES preserved so trailing legal forms can be identified, and
  // foldToken deliberately destroys them.
  const raw = (input.name ?? "").normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();

  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.includes(words[words.length - 1] as string)) {
    words.pop();
  }

  const stripped = words.join("");
  if (stripped.length < 3) return null;

  const country = foldToken(input.countryCode ?? "").slice(0, 2) || "__";
  return `c:${stripped}:${country}`;
}

/** Technology blocking key: the folded canonical name. No country — a product is global. */
export function technologyBlockKey(input: { canonicalName?: string | null }): string | null {
  const folded = foldToken(input.canonicalName ?? "");
  return folded.length < 2 ? null : `t:${folded}`;
}

/**
 * Decide whether a block may proceed to scoring.
 *
 * R5's practical ceilings are in COMPARISONS, not records, and a block of n records generates n(n-1)/2 of
 * them — so a block that merely looks large is quadratically expensive: 1,000 records is ~500,000 pairs.
 *
 * Returns the comparison count alongside the verdict so the sweep can LOG what it skipped. Silently dropping
 * an oversized block would read as "nothing to resolve here" when the truth is "this is the one place
 * duplicates are most likely to hide" — an over-large block usually means a very common surname, which is
 * exactly where real duplicates cluster.
 */
export function blockBudget(
  blockSize: number,
  maxComparisons = 20_000,
): { admit: boolean; comparisons: number } {
  // Math.max guards the empty/singleton block: (0 * -1)/2 is NEGATIVE ZERO in IEEE-754, which compares equal
  // to 0 but serialises as -0 and fails a strict structural assertion.
  const comparisons = Math.max(0, (blockSize * (blockSize - 1)) / 2);
  return { admit: comparisons <= maxComparisons, comparisons };
}
