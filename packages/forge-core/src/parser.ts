// @forge/core parser interface (08 §The parser interface). A parser is a PURE, DETERMINISTIC, TOTAL,
// PII-minimizing, provenance-emitting, framework-selected transform
// parse(rawPayload, endpoint, schemaVersion) → { normalized non-PII fields · field-level where-provenance ·
// non-fatal parse errors }. No I/O, no clock, no network — which is what makes it golden-file testable and
// replay-safe (invariants 1-5, 08). Runs server-side (parse worker), never in the browser.

/** Non-PII routing/provenance context — NEVER a data input; MUST NOT influence output (determinism). */
export interface ParserContext {
  source: string;
  captureId: string;
  capturedAt: string;
}

export interface ParserInput {
  rawPayload: unknown;
  endpoint: string;
  schemaVersion: string;
  ctx: ParserContext;
}

/** OpenLineage transformation subtype ([S87]). `derive` may carry a confidence; identity/normalize do not. */
export type Transformation = "identity" | "normalize" | "derive";

export interface ParseField {
  /** output field, e.g. "job_title" → parsed_records.fields */
  path: string;
  /** NORMALIZED, NON-PII value (clear PII never lands here — invariant 3) */
  value: unknown;
  /** where-provenance: the raw JSON path the value was copied from ([S93]) */
  sourcePath: string;
  transformation: Transformation;
  /** OpenLineage masking flag — true if the field is PII-derived ([S87]) */
  masking: boolean;
  /** set only for `derive`; a deterministic parse leaves it undefined (AI sets it in 09) */
  confidence?: number;
}

/** Closed parse-error vocabulary — all PII-FREE (safe for logs / DLQ / drift alert). */
export const PARSE_ERROR_CODES = [
  "MISSING_REQUIRED",
  "UNPARSEABLE_FIELD",
  "UNEXPECTED_SHAPE",
] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

export interface ParseError {
  code: ParseErrorCode;
  fieldPath?: string;
  message: string;
}

export type EntityKind = "person" | "company" | "employment" | "mixed";
export type ParseStatus = "parsed" | "partial" | "failed" | "quarantined";

export interface ParseResult {
  entityKind: EntityKind;
  fields: ParseField[];
  /** silver = BLIND INDEX ONLY (§B): the parser emits HMACs, never ciphertext or clear channel PII. */
  channels: { emailBlindIndex?: string; phoneBlindIndex?: string };
  /** ER blocking key (surname prefix / name n-gram) ([S39]). */
  blockKey: string;
  /** NON-FATAL — captured, not thrown (invariant 2). */
  errors: ParseError[];
  status: ParseStatus;
}

/** A parser is a pure function — no I/O, no clock, no network (invariant 1). */
export type Parser = (input: ParserInput) => ParseResult;

/** Helper: push a normalized field with where-provenance. */
export function field(
  fields: ParseField[],
  path: string,
  value: unknown,
  sourcePath: string,
  transformation: Transformation,
  masking = false,
): void {
  if (value === null || value === undefined || value === "") return;
  fields.push({ path, value, sourcePath, transformation, masking });
}
