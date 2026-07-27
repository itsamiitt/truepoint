// @forge/core extraction — pipeline stage S2 (09-ai-extraction-engine). AI-assisted structured extraction of
// the ambiguous/unstructured RESIDUE the deterministic parser (08) could not recover. Grammar-constrained
// decoding guarantees STRUCTURE, not CORRECTNESS [S47], so confidence is an EXTERNAL composite (grounding ×
// validator × judge − repair), never a model self-report [S49]. @forge/core owns the ExtractionPort; @forge/ai
// implements the Anthropic adapter (core-must-not-import-ai) — the port is INJECTED, so this runs at zero live
// spend in tests. Extraction runs DARK until DPA/legal sign-off (OQ-2, ADR-0046); this is the logic, not the gate.

// ── the provider-agnostic port (mirrors TruePoint aiPort.ts, ecosystem-facts §C) ──────────────────────
export interface ExtractedField {
  path: string;
  value: unknown;
  /** char-offset grounding into the residue (LangExtract [S48]); null when the model gives none. */
  offset: { start: number; end: number } | null;
}

export type ExtractionOutcomeCode =
  | "ok"
  | "repaired"
  | "ai_invalid_output"
  | "refused"
  | "truncated"
  | "ai_unavailable";

export interface ExtractionRequest {
  residue: string;
  targetFields: string[];
  schemaVersion: string;
}

export interface ExtractionOutcome {
  outcome: ExtractionOutcomeCode;
  fields: ExtractedField[];
  usedRepair: boolean;
  model: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExtractionPort {
  extract(req: ExtractionRequest): Promise<ExtractionOutcome>;
}

// ── deterministic-vs-AI routing predicate (09 §routing boundary) ──────────────────────────────────────
export interface FieldForRouting {
  value: unknown;
  lowConfidence?: boolean;
  residueFreeText: boolean;
}

/** AI-eligible iff the deterministic parser produced null/low-confidence AND the residue is free-text (09 §routing).
 *  Everything a stable parser covers SKIPS the model — the single biggest cost lever [S47][S81]. */
export function isAiEligible(f: FieldForRouting): boolean {
  const missing = f.value === null || f.value === undefined || f.value === "";
  return (missing || f.lowConfidence === true) && f.residueFreeText;
}

// ── prompt guard (mirrors promptGuard.ts, §C) — untrusted residue is DATA, not instructions ───────────
const INJECTION =
  /(ignore\s+(the\s+)?(previous|above|prior)|disregard\s+(all|the)|system\s+prompt|you\s+are\s+now|\bact\s+as\b|new\s+instructions)/i;

/** Reject an obvious prompt-injection attempt up front — NO model spend (§C). */
export function looksLikeInjection(residue: string): boolean {
  return INJECTION.test(residue);
}

/** Strip control chars / code fences and cap length before the model sees the residue (§C).
 *
 *  The control-char class below is written as ESCAPES, never as literal bytes. It previously held a literal
 *  NUL, which made this whole file "binary" to `grep` and invisible to `git grep -I` — so the one sanitizer
 *  standing between scraped page content and a model prompt could not be read in a diff or found by a
 *  search. Keep it escaped. */
export function sanitizeResidue(residue: string): string {
  return (
    residue
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char strip
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/```/g, " ")
      .slice(0, 8000)
      .trim()
  );
}

// ── budget guard (mirrors budgetGuard.ts, §C) — circuit-break BEFORE spend, refund on failure ─────────
//
// The budget bounds MONEY on a path an outsider can trigger (a capture arrives → an Anthropic call is billed).
// Three properties follow from that, and each one was previously missing:
//
//   1. The key must aggregate. It was `${jobId}:${tenantId}` with jobId = the rawCaptureId, so every capture
//      opened a fresh counter and burnt exactly one unit of it. A 1000-unit limit that resets per capture
//      cannot be reached, so AI_BUDGET_LIMIT bounded nothing at all. Now: tenant + time window (aiBudgetKey).
//   2. It must be shared. A per-process Map bounds one worker, and N workers then bill N × the limit. The
//      store is a port so the deployed path can be Redis (see forgeAiBudgetStore in @leadwolf/integrations).
//   3. Reserve/release must be atomic. get-then-set is a read-modify-write: two concurrent extractions read
//      the same total and both write limit+1. `reserve` returns the post-increment total instead, so the
//      decision is made on a value only one caller can observe.
export interface AiBudgetStore {
  /** Atomically add `units` to `key`'s total and return the NEW total. Returning the post-increment value is
   *  what makes the limit decision race-free — the caller never re-reads. */
  reserve(key: string, units: number): Promise<number>;
  /** Give `units` back (never below zero). Used to refund an unspent reservation. */
  release(key: string, units: number): Promise<void>;
}

/** One UTC day. The limit is "paid extractions per tenant per window", so the window is the unit the number
 *  is quoted in — change one and the other stops meaning what it says. */
export const AI_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The budget key: TENANT plus the current window. Deliberately not per-job — see (1) above. */
export function aiBudgetKey(
  tenantId: string,
  now: number = Date.now(),
  windowMs: number = AI_BUDGET_WINDOW_MS,
): string {
  return `forge:aibudget:${tenantId}:${Math.floor(now / windowMs)}`;
}

/** Process-local store. Fine for tests and a single worker; NOT the deployed path (see (2) above).
 *  Entries expire, because the key embeds a window: without expiry the map keeps one entry per tenant per
 *  window forever, which in a long-lived worker is an unbounded leak. (The old store leaked far faster — one
 *  entry per capture — and never dropped any of them.) */
export function inMemoryBudgetStore(ttlMs: number = 2 * AI_BUDGET_WINDOW_MS): AiBudgetStore {
  const m = new Map<string, { value: number; expiresAt: number }>();
  const sweep = (now: number) => {
    for (const [k, entry] of m) if (entry.expiresAt <= now) m.delete(k);
  };
  return {
    async reserve(key, units) {
      const now = Date.now();
      sweep(now);
      const existing = m.get(key);
      const base = existing && existing.expiresAt > now ? existing.value : 0;
      const value = base + units;
      m.set(key, { value, expiresAt: now + ttlMs });
      return value;
    },
    async release(key, units) {
      const entry = m.get(key);
      if (!entry) return;
      entry.value = Math.max(0, entry.value - units);
    },
  };
}

export class AiBudgetExceededError extends Error {
  constructor(key: string) {
    super(`AI budget exhausted: ${key}`);
    this.name = "AiBudgetExceededError";
  }
}

/** Reserve BEFORE the paid call. Over-limit reservations are rolled back so a rejected attempt does not
 *  permanently consume the budget it was denied. */
export async function reserveAiBudget(
  store: AiBudgetStore,
  key: string,
  limit: number,
  units = 1,
): Promise<void> {
  const total = await store.reserve(key, units);
  if (total > limit) {
    await store.release(key, units);
    throw new AiBudgetExceededError(key);
  }
}

/** Refund on failure — only successful calls consume budget (§C). */
export async function releaseAiBudget(store: AiBudgetStore, key: string, units = 1): Promise<void> {
  await store.release(key, units);
}

// ── grounding (must-ground-in-payload, 09 §Guardrails guard 2, [S48]) ─────────────────────────────────
export function normalizeForGrounding(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A field is grounded iff its value is literally present (post-normalization) at its claimed offset in the
 *  residue — the guard that catches a WELL-TYPED HALLUCINATION the grammar cannot ([S47][S48]). An explicit
 *  absent value (null/"") is a valid, grounded "unknown" (refuse-on-uncertain). */
export function isGrounded(field: ExtractedField, residue: string): boolean {
  if (field.value === null || field.value === undefined) return true;
  const v = normalizeForGrounding(String(field.value));
  if (v === "") return true;
  if (field.offset) {
    const span = normalizeForGrounding(residue.slice(field.offset.start, field.offset.end));
    return span.includes(v) || v.includes(span);
  }
  return normalizeForGrounding(residue).includes(v);
}

// ── grounded-confidence composite (09 §Confidence) — NEVER a model self-report [S49] ──────────────────
export interface ConfidenceInputs {
  grounded: boolean;
  validatorOk: boolean;
  judgeScore: number; // 0..1 from an external LLM-as-judge pass [S51]
  usedRepair: boolean;
}

const W_GROUND = 0.4;
const W_VALID = 0.3;
const W_JUDGE = 0.3;
const REPAIR_PENALTY = 0.15;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** grounding × validator (hard floors → 0) + weighted judge − repair penalty (09 §Confidence). */
export function groundedConfidence(i: ConfidenceInputs): number {
  if (!i.grounded || !i.validatorOk) return 0;
  const score =
    W_GROUND + W_VALID + W_JUDGE * clamp01(i.judgeScore) - (i.usedRepair ? REPAIR_PENALTY : 0);
  return clamp01(score);
}

/** Azure-DI-shape confidence gate [S49]; the value is OQ-R13 (pilot-calibrated, not adopted blind). */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;
export type ExtractionBand = "auto" | "review" | "quarantine";

/** Route a field: sensitive PII channels ALWAYS review (~100% posture); below threshold → review (09 §gate). */
export function routeByConfidence(confidence: number, sensitive: boolean): ExtractionBand {
  if (sensitive) return "review";
  return confidence >= HIGH_CONFIDENCE_THRESHOLD ? "auto" : "review";
}

// ── the extraction stage (09 §adapter; wraps the port with guards, §C) ────────────────────────────────
export interface ExtractionRunRow {
  jobId: string;
  tenantId: string;
  model: string;
  outcome: string;
  usedRepair: boolean;
  extractSchemaVersion: string;
  groundingCoverage: number;
  judgeScore: number;
  confidence: number;
  /** Provider accounting, passed straight through to the extraction_runs columns of the same names. Optional
   *  because the pre-flight injection refusal and a transport failure never reach the provider. */
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface ExtractStageDeps {
  port: ExtractionPort;
  budgetStore: AiBudgetStore;
  budgetLimit: number;
  /** immutable metering write (→ extraction_runs; mirrors ai_requests, never stores the extracted value). */
  meter: (row: ExtractionRunRow) => Promise<void>;
  /** optional LLM-as-judge; defaults to 1 (a bias-mitigated real judge is wired later). */
  judge?: (residue: string, field: ExtractedField) => Promise<number>;
}

export interface ExtractStageCtx {
  jobId: string;
  tenantId: string;
  residue: string;
  targetFields: string[];
  schemaVersion: string;
  sensitiveFields?: string[];
}

export interface ExtractStageResult {
  outcome: string;
  fields: Array<{
    path: string;
    value: unknown;
    confidence: number;
    band: ExtractionBand;
    grounded: boolean;
  }>;
}

const QUARANTINE_OUTCOMES = new Set(["ai_invalid_output", "refused", "truncated"]);

/** A single extraction can cost TWO provider calls, because the port may follow a malformed response with a
 *  repair pass. The worst case is what gets reserved: reserving one and discovering the second after the fact
 *  lets every repairing extraction spend a unit the budget never authorised, so a tenant whose payloads
 *  reliably trigger repair bills double its limit. The unused unit is refunded once the outcome says whether
 *  repair actually ran. */
const EXTRACTION_WORST_CASE_UNITS = 2;

export async function runExtraction(
  deps: ExtractStageDeps,
  ctx: ExtractStageCtx,
): Promise<ExtractStageResult> {
  const budgetKey = aiBudgetKey(ctx.tenantId);

  // Injection → quarantine, NO spend (§C).
  if (looksLikeInjection(ctx.residue)) {
    await deps.meter(runRow(ctx, { model: "prompt-guard", outcome: "refused" }));
    return { outcome: "refused", fields: [] };
  }
  const residue = sanitizeResidue(ctx.residue);

  // Budget reserve BEFORE the paid call; an exhausted budget PARKS the job (not a 429).
  try {
    await reserveAiBudget(
      deps.budgetStore,
      budgetKey,
      deps.budgetLimit,
      EXTRACTION_WORST_CASE_UNITS,
    );
  } catch (err) {
    if (err instanceof AiBudgetExceededError) return { outcome: "budget_exceeded", fields: [] };
    throw err;
  }
  /** Refund whatever the reservation over-booked, now that the real call count is known. */
  const settleReservation = (usedRepair: boolean) =>
    releaseAiBudget(
      deps.budgetStore,
      budgetKey,
      EXTRACTION_WORST_CASE_UNITS - (usedRepair ? 2 : 1),
    );

  let result: ExtractionOutcome;
  try {
    result = await deps.port.extract({
      residue,
      targetFields: ctx.targetFields,
      schemaVersion: ctx.schemaVersion,
    });
  } catch {
    // Nothing billable completed — refund the whole reservation (§C).
    await releaseAiBudget(deps.budgetStore, budgetKey, EXTRACTION_WORST_CASE_UNITS);
    await deps.meter(runRow(ctx, { model: "unknown", outcome: "ai_unavailable" }));
    return { outcome: "ai_unavailable", fields: [] };
  }

  if (result.outcome === "ai_unavailable") {
    await releaseAiBudget(deps.budgetStore, budgetKey, EXTRACTION_WORST_CASE_UNITS);
    await deps.meter(runRow(ctx, { model: result.model, outcome: "ai_unavailable", result }));
    return { outcome: "ai_unavailable", fields: [] };
  }
  // Quarantine outcomes are BILLED: the provider answered, it just answered unusably. Only the over-booked
  // unit comes back.
  if (QUARANTINE_OUTCOMES.has(result.outcome)) {
    await settleReservation(result.usedRepair);
    await deps.meter(runRow(ctx, { model: result.model, outcome: result.outcome, result }));
    return { outcome: result.outcome, fields: [] };
  }
  await settleReservation(result.usedRepair);

  // Guardrails + grounded-confidence per field.
  const fields: ExtractStageResult["fields"] = [];
  let groundingHits = 0;
  let judgeTotal = 0;
  let confidenceTotal = 0;
  for (const f of result.fields) {
    const grounded = isGrounded(f, residue);
    if (grounded) groundingHits += 1;
    const validatorOk = f.value !== undefined; // authoritative Zod/DAMA validation is downstream (05 Group 5)
    const judgeScore = deps.judge ? await deps.judge(residue, f) : 1;
    judgeTotal += judgeScore;
    const confidence = groundedConfidence({
      grounded,
      validatorOk,
      judgeScore,
      usedRepair: result.usedRepair,
    });
    confidenceTotal += confidence;
    const sensitive = (ctx.sensitiveFields ?? []).includes(f.path);
    const band: ExtractionBand = grounded ? routeByConfidence(confidence, sensitive) : "quarantine";
    fields.push({ path: f.path, value: f.value, confidence, band, grounded });
  }

  const n = result.fields.length || 1;
  const outcome = result.usedRepair ? "repaired" : "ok";
  await deps.meter(
    runRow(ctx, {
      model: result.model,
      outcome,
      result,
      groundingCoverage: groundingHits / n,
      judgeScore: judgeTotal / n,
      confidence: confidenceTotal / n,
    }),
  );
  return { outcome, fields };
}

/** Build the immutable metering row.
 *
 *  Takes an options object rather than seven positional arguments: the previous signature ended in three
 *  interchangeable numbers that every error path passed as `0, 0, 0`, and this change adds three more. A
 *  transposed pair there is invisible at the call site and silently corrupts the metering record.
 *
 *  `result` carries the provider's own accounting through. latency and token counts were previously dropped
 *  on every path — the port returns them and the extraction_runs table has had `latency_ms`, `input_tokens`,
 *  `output_tokens` and `cached_tokens` columns all along, so the spend record was structurally present and
 *  always empty. Without it there is no way to answer what a tenant actually cost, which is the question a
 *  metered pipeline exists to answer. */
function runRow(
  ctx: ExtractStageCtx,
  args: {
    model: string;
    outcome: string;
    /** The provider outcome, when there was one. Absent for the pre-flight refusal and transport failures. */
    result?: ExtractionOutcome;
    groundingCoverage?: number;
    judgeScore?: number;
    confidence?: number;
  },
): ExtractionRunRow {
  return {
    jobId: ctx.jobId,
    tenantId: ctx.tenantId,
    model: args.model,
    outcome: args.outcome,
    usedRepair: args.result?.usedRepair ?? false,
    extractSchemaVersion: ctx.schemaVersion,
    groundingCoverage: args.groundingCoverage ?? 0,
    judgeScore: args.judgeScore ?? 0,
    confidence: args.confidence ?? 0,
    latencyMs: args.result?.latencyMs,
    inputTokens: args.result?.inputTokens,
    outputTokens: args.result?.outputTokens,
  };
}
