// Forge data-plane repositories (ADR-0047; docs/planning/forge/04) — the tx-scoped ingest → parse → extract →
// verify → sync write/read primitives. Every function takes a `tx: Tx`; the caller wraps the call in
// withForgeTx (leadwolf_forge). The API/workers adapt these to @leadwolf/forge-core's ports (no db→core cycle).
export { landRawCapture, type RawCaptureInsert } from "./rawCaptureRepository.ts";
export { upsertParsedRecord, type ParsedRecordUpsert } from "./parsedRecordRepository.ts";
export { insertExtractionRun, type ExtractionRunInsert } from "./extractionRunRepository.ts";
export {
  countExtractionCandidates,
  insertExtractionCandidates,
  type ExtractionCandidateInsert,
} from "./extractionCandidateRepository.ts";
export { promoteVerifiedRecord, type PromotionInput } from "./promotionRepository.ts";
export {
  getRawCaptureForParse,
  getRawCaptureById,
  getVerifyInputs,
  getPipelineOverviewCounts,
  listReviewTasks,
  listParsers,
  getSyncStatusCounts,
  type RawCaptureRowForParse,
  type RawCaptureRowById,
  type VerifyInputsRow,
  type PipelineOverview,
  type ReviewTaskRow,
  type ParserRow,
  type SyncStatusCounts,
} from "./readRepository.ts";
export {
  insertApprovalRequest,
  insertQuarantine,
  insertReviewTask,
} from "./governanceRepository.ts";
export {
  drainSyncOutbox,
  markSyncOutboxDispatched,
  markSyncStateSynced,
  upsertMasterIdMap,
  type DrainedOutboxRow,
} from "./syncRepository.ts";
