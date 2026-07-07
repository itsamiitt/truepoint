// @forge/core entity resolution — Forge-owned Fellegi-Sunter ER (P5, ADR-0047; corpus ws06 [S35]-[S42]).
// Collapses duplicate candidates into golden entities: additive log2 "bits of evidence" scoring with a
// mandatory term-frequency adjustment [S36], UNION blocking to beat O(n²) [S39], connected-components
// clustering [S37], and a two-threshold band (auto-merge / grey-zone / auto-reject) [S38]. Pure + deterministic
// — the grey zone routes to the P4 review queue; nothing here auto-writes production. The log2 form makes each
// field's contribution an auditable waterfall [S42].

// ── Fellegi-Sunter scoring ([S35][S36]) ───────────────────────────────────────────────────────────────
export interface FieldConfig {
  field: string;
  /** P(field agrees | the pair is a true match). */
  m: number;
  /** P(field agrees | the pair is a non-match). */
  u: number;
}

export interface FieldObservation {
  field: string;
  agree: boolean;
  /** fraction of records carrying this value (for the TF adjustment); omit to use the base u. */
  valueFrequency?: number;
}

/** The prior log-odds of a match (bits): log2(λ/(1-λ)). */
export function baseWeight(lambda: number): number {
  return Math.log2(lambda / (1 - lambda));
}

/** Term-frequency adjustment: a rare value gets a smaller u (bigger agreement bonus); common values a penalty
 *  — without it, common-name matches over-score [S36]. Clamped away from 0. */
export function tfAdjustedU(baseU: number, valueFrequency: number): number {
  return Math.max(1e-6, Math.min(baseU, valueFrequency));
}

/** One field's contribution in bits: agree → log2(m/u); disagree → log2((1-m)/(1-u)) [S35]. */
export function fieldWeight(cfg: FieldConfig, agree: boolean, valueFrequency?: number): number {
  const u = valueFrequency !== undefined ? tfAdjustedU(cfg.u, valueFrequency) : cfg.u;
  return agree ? Math.log2(cfg.m / u) : Math.log2((1 - cfg.m) / (1 - u));
}

/** Total match weight = base + Σ field contributions (the bits-of-evidence waterfall [S42]). */
export function matchWeight(
  lambda: number,
  observations: FieldObservation[],
  configs: Map<string, FieldConfig>,
): number {
  let w = baseWeight(lambda);
  for (const obs of observations) {
    const cfg = configs.get(obs.field);
    if (cfg) w += fieldWeight(cfg, obs.agree, obs.valueFrequency);
  }
  return w;
}

/** probability = 2^w/(1+2^w), computed as the numerically-stable sigmoid 1/(1+2^-w) [S35]. */
export function matchProbability(weight: number): number {
  return 1 / (1 + 2 ** -weight);
}

// ── two-threshold routing ([S38]) ─────────────────────────────────────────────────────────────────────
export type MatchDisposition = "auto_merge" | "grey_zone" | "auto_reject";

export interface Thresholds {
  /** weight ≥ this → auto-merge. */
  autoMergeAbove: number;
  /** weight ≤ this → auto-reject. Between the two → grey zone → human review (P4). */
  autoRejectBelow: number;
}

export function routeMatch(weight: number, t: Thresholds): MatchDisposition {
  if (weight >= t.autoMergeAbove) return "auto_merge";
  if (weight <= t.autoRejectBelow) return "auto_reject";
  return "grey_zone";
}

// ── blocking — UNION keys to beat O(n²) ([S39]) ───────────────────────────────────────────────────────
export interface BlockableRecord {
  id: string;
  lastName?: string;
  emailDomain?: string;
  linkedinPublicId?: string;
}

/** Blocking keys for a record — surname prefix / email domain / linkedin id. UNION (share ANY key → candidate). */
export function blockingKeys(r: BlockableRecord): string[] {
  const keys: string[] = [];
  if (r.lastName)
    keys.push(
      `ln:${r.lastName
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 4)}`,
    );
  if (r.emailDomain) keys.push(`dom:${r.emailDomain.toLowerCase()}`);
  if (r.linkedinPublicId) keys.push(`li:${r.linkedinPublicId.toLowerCase()}`);
  return keys;
}

/** Candidate pairs: two records that share ANY blocking key (OR, not intersect — protects recall [S39]). */
export function candidatePairs<T extends { id: string }>(
  records: T[],
  keysOf: (r: T) => string[],
): Array<[T, T]> {
  const buckets = new Map<string, T[]>();
  for (const r of records) {
    for (const k of keysOf(r)) {
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = [];
        buckets.set(k, bucket);
      }
      bucket.push(r);
    }
  }
  const seen = new Set<string>();
  const pairs: Array<[T, T]> = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (!a || !b) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** Largest-block diagnostic — an over-permissive key that explodes a block silently kills quality [S39]. */
export function largestBlockSize<T>(records: T[], keysOf: (r: T) => string[]): number {
  const counts = new Map<string, number>();
  for (const r of records) for (const k of keysOf(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts.size === 0 ? 0 : Math.max(...counts.values());
}

// ── connected-components clustering ([S37]) ───────────────────────────────────────────────────────────
/** Collapse matched pairs into entity clusters via union-find. */
export function connectedComponents(ids: string[], edges: Array<[string, string]>): string[][] {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== parent.get(root)) {
      const next = parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    parent.set(x, root);
    return root;
  };
  for (const [a, b] of edges) {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(id);
  }
  return [...groups.values()];
}

// ── survivorship / best-version-of-truth ([S27][S28][S33]) ────────────────────────────────────────────
export interface AttributeCandidate {
  value: unknown;
  /** source authority 0..1 (a paid provider > a scraped page). */
  authority: number;
  /** passed field validation. */
  validated: boolean;
  /** field completeness 0..1. */
  completeness: number;
  /** observation time (recency is the LAST tiebreak, never the first — the Reltio footgun [S28][S33]). */
  observedAt: number;
}

/** Per-attribute best-version-of-truth: authority > validation > completeness > recency. */
export function pickSurvivor(candidates: AttributeCandidate[]): AttributeCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      b.authority - a.authority ||
      Number(b.validated) - Number(a.validated) ||
      b.completeness - a.completeness ||
      b.observedAt - a.observedAt,
  )[0] as AttributeCandidate;
}
