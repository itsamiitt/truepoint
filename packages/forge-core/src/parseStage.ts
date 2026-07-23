// @forge/core parse stage — S1 (06 §S1, 08). Pure orchestration over injected ports so it is unit-testable
// without live infra: select the parser_version → fetch raw from bronze → run the pure parser → upsert the
// parsed_record (idempotent on (raw_capture_id, parser_version_id)); any selection/shape/parse drift routes to
// the quarantine lane (never silently into silver). The parse stage never blocks; a data fault is a result.
import type { ParseResult } from "./parser.ts";
import type { ParserRegistry } from "./parserRegistry.ts";

export interface RawCaptureForParse {
  id: string;
  source: string;
  endpoint: string;
  schemaVersion: string;
  fingerprint: string;
  payloadInline: string | null;
  payloadRef: string | null;
  capturedAt: string;
}

export interface ParsedRecordUpsert {
  rawCaptureId: string;
  parserVersionId: string;
  status: string;
  fields: unknown;
  provenance: unknown;
  errors: unknown;
  /** ER blocking key + silver blind indexes (§B) — carried through to parsed_records so ER blocking and
   *  DSAR-on-silver actually work (P-01.3); the parser emits HMAC blind indexes only, never clear channel PII. */
  blockKey?: string;
  emailBlindIndex?: string;
  phoneBlindIndex?: string;
}

/** Idempotent upsert keyed on (raw_capture_id, parser_version_id) — a re-derivation converges (08 §Replay). */
export interface ParsedRecordStore {
  upsert(row: ParsedRecordUpsert): Promise<{ written: boolean }>;
}
/** Fetch a large raw payload from the object store (the ONLY I/O in the parse stage; bounded transient retry). */
export interface BlobFetcher {
  fetch(ref: string): Promise<string>;
}
/** Route a selection/shape/parse miss to the quarantine lane + alert (lane owned by 06). PII-free. */
export interface Quarantine {
  record(rawCaptureId: string, route: string, reason: string): Promise<void>;
}

export interface ParseStageDeps {
  registry: ParserRegistry;
  store: ParsedRecordStore;
  blob: BlobFetcher;
  quarantine: Quarantine;
}

/** Raw-shape fingerprint = sorted top-level keys (08 §selection; computed at ingest per 06, carried on the row). */
export function shapeFingerprint(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  return Object.keys(payload as Record<string, unknown>)
    .sort()
    .join(",");
}

export async function runParse(
  deps: ParseStageDeps,
  capture: RawCaptureForParse,
): Promise<{ outcome: string; parserVersionId?: string }> {
  const selection = deps.registry.select(
    capture.source,
    capture.endpoint,
    capture.schemaVersion,
    capture.fingerprint,
  );
  if (selection.kind === "quarantine") {
    await deps.quarantine.record(capture.id, selection.route, selection.reason);
    return { outcome: selection.route };
  }

  const rawText =
    capture.payloadInline ?? (capture.payloadRef ? await deps.blob.fetch(capture.payloadRef) : "");
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = rawText;
  }

  const result: ParseResult = selection.version.parser({
    rawPayload: payload,
    endpoint: capture.endpoint,
    schemaVersion: capture.schemaVersion,
    ctx: { source: capture.source, captureId: capture.id, capturedAt: capture.capturedAt },
  });

  if (result.status === "quarantined") {
    await deps.quarantine.record(
      capture.id,
      "PARSE_QUARANTINE",
      result.errors[0]?.message ?? "quarantined",
    );
    return { outcome: "quarantined", parserVersionId: selection.version.id };
  }

  await deps.store.upsert({
    rawCaptureId: capture.id,
    parserVersionId: selection.version.id,
    status: result.status,
    fields: result.fields,
    provenance: result.fields.map((f) => ({
      path: f.path,
      sourcePath: f.sourcePath,
      transformation: f.transformation,
      masking: f.masking,
    })),
    errors: result.errors,
    blockKey: result.blockKey,
    emailBlindIndex: result.channels.emailBlindIndex,
    phoneBlindIndex: result.channels.phoneBlindIndex,
  });
  return { outcome: result.status, parserVersionId: selection.version.id };
}
