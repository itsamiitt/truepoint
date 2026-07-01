// stringSimilarity.ts — Jaro-Winkler string similarity (pure) for I5 probabilistic ER name comparison. Standard
// for person/company names: tolerant of typos + transpositions, with a prefix bonus (names that share a prefix are
// likelier the same). Returns a similarity in [0,1]. No DB, no I/O, no randomness. The comparison layer
// (compareRecords) discretizes this into agree/disagree/not_compared for the Fellegi-Sunter scorer.

/** Jaro similarity ∈ [0,1] — matches within a sliding window, penalized by transpositions. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  // Two characters match only if they are within this many positions of each other.
  const matchDistance = Math.max(0, Math.floor(Math.max(lenA, lenB) / 2) - 1);
  const aMatched = new Array<boolean>(lenA).fill(false);
  const bMatched = new Array<boolean>(lenB).fill(false);

  let matches = 0;
  for (let i = 0; i < lenA; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, lenB);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions: matched chars that appear out of order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lenA; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const t = transpositions / 2;

  return (matches / lenA + matches / lenB + (matches - t) / matches) / 3;
}

/**
 * Jaro-Winkler similarity ∈ [0,1]: Jaro plus a bonus for a shared prefix (up to 4 chars), scaling factor `p`
 * (0.1 standard, capped so the result stays ≤ 1). Higher = more similar.
 */
export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  let prefix = 0;
  for (let i = 0; i < maxPrefix; i += 1) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }
  return j + prefix * Math.min(p, 0.25) * (1 - j);
}
