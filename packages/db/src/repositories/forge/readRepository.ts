// readRepository — the read-side queries backing the dashboard BFF + the parse processor (Phase 3). Plain
// functions over a tx-scoped Tx (no db→core cycle). These replace the API's hardcoded-zero BFF stubs and give
// the parse worker its raw-capture input.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import {
  approvalRequests,
  extractionCandidates,
  parsedRecords,
  parserVersions,
  parsers,
  rawCaptures,
  reviewTasks,
  syncState,
  verifiedRecords,
} from "../../schema/forge.ts";

const countInt = sql<number>`count(*)::int`;

/** The raw-capture fields the parse processor needs (it computes the shape fingerprint from the payload). */
export interface RawCaptureRowForParse {
  id: string;
  source: string;
  endpoint: string;
  schemaVersion: string;
  payloadInline: string | null;
  payloadRef: string | null;
  ingestedAt: Date;
}

export async function getRawCaptureForParse(
  tx: Tx,
  contentHash: string,
): Promise<RawCaptureRowForParse | null> {
  const rows = await tx
    .select({
      id: rawCaptures.id,
      source: rawCaptures.source,
      endpoint: rawCaptures.endpoint,
      schemaVersion: rawCaptures.schemaVersion,
      payloadInline: rawCaptures.payloadInline,
      payloadRef: rawCaptures.payloadRef,
      ingestedAt: rawCaptures.ingestedAt,
    })
    .from(rawCaptures)
    .where(eq(rawCaptures.contentHash, contentHash))
    .limit(1);
  return rows[0] ?? null;
}

/** The raw capture by id + its tenant/residue — the ai-extract processor's input. */
export interface RawCaptureRowById extends RawCaptureRowForParse {
  targetTenantId: string;
}

export async function getRawCaptureById(tx: Tx, id: string): Promise<RawCaptureRowById | null> {
  const rows = await tx
    .select({
      id: rawCaptures.id,
      source: rawCaptures.source,
      endpoint: rawCaptures.endpoint,
      schemaVersion: rawCaptures.schemaVersion,
      payloadInline: rawCaptures.payloadInline,
      payloadRef: rawCaptures.payloadRef,
      ingestedAt: rawCaptures.ingestedAt,
      targetTenantId: rawCaptures.targetTenantId,
    })
    .from(rawCaptures)
    .where(eq(rawCaptures.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** The silver inputs the verify stage assembles into a gold candidate (P-01.10 producer): the newest
 *  non-superseded parsed record for a capture, its channel blind indexes, the capturer (the four-eyes MAKER),
 *  and the AI-extract per-field confidence/band signal. Null when there is no parsed record (nothing to verify). */
export interface VerifyInputsRow {
  entityKind: "person" | "company";
  parsedFields: unknown;
  emailBlindIndex: string | null;
  phoneBlindIndex: string | null;
  capturedByUserId: string | null;
  extractions: Array<{ confidence: number; band: string }>;
}

export async function getVerifyInputs(tx: Tx, rawCaptureId: string): Promise<VerifyInputsRow | null> {
  const [pr] = await tx
    .select({
      entityKind: parsedRecords.entityKind,
      fields: parsedRecords.fields,
      emailBlindIndex: parsedRecords.emailBlindIndex,
      phoneBlindIndex: parsedRecords.phoneBlindIndex,
    })
    .from(parsedRecords)
    .where(and(eq(parsedRecords.rawCaptureId, rawCaptureId), eq(parsedRecords.superseded, false)))
    .limit(1);
  if (!pr) return null;
  const [cap] = await tx
    .select({ capturedByUserId: rawCaptures.capturedByUserId })
    .from(rawCaptures)
    .where(eq(rawCaptures.id, rawCaptureId))
    .limit(1);
  const cands = await tx
    .select({ confidence: extractionCandidates.confidence, band: extractionCandidates.band })
    .from(extractionCandidates)
    .where(eq(extractionCandidates.rawCaptureId, rawCaptureId));
  return {
    entityKind: pr.entityKind === "company" ? "company" : "person",
    parsedFields: pr.fields,
    emailBlindIndex: pr.emailBlindIndex,
    phoneBlindIndex: pr.phoneBlindIndex,
    capturedByUserId: cap?.capturedByUserId ?? null,
    extractions: cands.map((c) => ({ confidence: Number(c.confidence), band: c.band })),
  };
}

/** The persisted approval request the four-eyes approve path loads (P-01.10 consumer) — the SERVER-authoritative
 *  maker + candidate, so the approver's request body supplies nothing but the id and can neither forge the maker
 *  (to bypass checker≠maker) nor the confidence/fields (to clear the threshold / promote arbitrary data). */
export interface ApprovalRequestRow {
  requestedByUserId: string;
  status: string;
  payload: unknown;
}

export async function getApprovalRequest(tx: Tx, id: string): Promise<ApprovalRequestRow | null> {
  const [row] = await tx
    .select({
      requestedByUserId: approvalRequests.requestedByUserId,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return row ?? null;
}

export interface PipelineOverview {
  captured: number;
  parsed: number;
  verified: number;
  synced: number;
}

/** The medallion funnel counts (raw → parsed → verified → synced). */
export async function getPipelineOverviewCounts(tx: Tx): Promise<PipelineOverview> {
  const [captured] = await tx.select({ n: countInt }).from(rawCaptures);
  const [parsed] = await tx
    .select({ n: countInt })
    .from(parsedRecords)
    .where(eq(parsedRecords.superseded, false));
  const [verified] = await tx.select({ n: countInt }).from(verifiedRecords);
  const [synced] = await tx
    .select({ n: countInt })
    .from(syncState)
    .where(eq(syncState.status, "synced"));
  return {
    captured: captured?.n ?? 0,
    parsed: parsed?.n ?? 0,
    verified: verified?.n ?? 0,
    synced: synced?.n ?? 0,
  };
}

export interface ReviewTaskRow {
  id: string;
  taskType: string;
  confidence: number;
  priority: number;
  subjectRef: string;
}

/** The agreement-ranked open review queue (priority desc). */
export async function listReviewTasks(tx: Tx, limit = 50): Promise<ReviewTaskRow[]> {
  return tx
    .select({
      id: reviewTasks.id,
      taskType: reviewTasks.taskType,
      confidence: sql<number>`coalesce(${reviewTasks.confidence}, 0)::float8`,
      priority: reviewTasks.priority,
      subjectRef: reviewTasks.subjectRef,
    })
    .from(reviewTasks)
    .where(eq(reviewTasks.status, "open"))
    .orderBy(desc(reviewTasks.priority))
    .limit(limit);
}

export interface ParserRow {
  id: string;
  source: string;
  endpoint: string;
  activeVersion: string | null;
}

/** The parser registry with each parser's active version (null if none published). */
export async function listParsers(tx: Tx): Promise<ParserRow[]> {
  return tx
    .select({
      id: parsers.id,
      source: parsers.source,
      endpoint: parsers.endpoint,
      activeVersion: parserVersions.version,
    })
    .from(parsers)
    .leftJoin(
      parserVersions,
      and(eq(parserVersions.parserId, parsers.id), eq(parserVersions.status, "active")),
    );
}

export interface SyncStatusCounts {
  pending: number;
  synced: number;
  failed: number;
}

export async function getSyncStatusCounts(tx: Tx): Promise<SyncStatusCounts> {
  const rows = await tx
    .select({ status: syncState.status, n: countInt })
    .from(syncState)
    .groupBy(syncState.status);
  const by = new Map(rows.map((r) => [r.status, r.n]));
  return {
    pending: by.get("pending") ?? 0,
    synced: by.get("synced") ?? 0,
    failed: by.get("failed") ?? 0,
  };
}
