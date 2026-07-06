// Public surface of @leadwolf/core — domain logic shared by apps/api and apps/workers. M1 exposes the
// import pipeline + the PII/dedup primitives; M3 adds the money loop (reveal transaction, suppression
// gate, audit writer, Stripe grant). Internals (normalize, contentHash, columnMap) stay private; import
// them relatively from within the package (incl. co-located tests).

export { runImport, type RunImportInput } from "./import/runImport.ts";
export { parseImportFile, parseCsv, isXlsxFile, type ParsedCsv } from "./import/parseFile.ts";
export { parseXlsx } from "./import/parseXlsx.ts";
// Upload-admission envelope (import-redesign 13 §1, S-S1): content sniffing (magic bytes, encoding, NUL),
// the admission cap constants (the ONE local spot — S-P2 centralizes), consumed by the api upload routes.
export {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_CSV_SNIFF_PREFIX_BYTES,
  IMPORT_MULTIPART_MAX_FIELD_BYTES,
  IMPORT_MULTIPART_MAX_PARTS,
  IMPORT_UPLOAD_REQUEST_MAX_BYTES,
  IMPORT_XLSX_MAX_BYTES,
  assertCsvPrefixAdmissible,
  assertXlsxAdmissible,
  assertXlsxArchiveWithinLimits,
  decodeAdmittedCsv,
  hasZipMagic,
} from "./import/admission.ts";
// Constant-memory streaming CSV reader for the bulk-import drive path (15-bulk-import-design §3) — parses
// byte-identically to the sync parseCsv (the quoting state machine mirrors parseFile.ts parseMatrix). CSV only.
export { streamParseCsv } from "./import/streamParse.ts";
// Bulk COPY-staging import pipeline (15-bulk-import-design §2, phase 5) — DRIVE (stage + fan-out), per-chunk MERGE
// (byte-identical landing parity with runImport, batched), and the finalize hook. DEAD CODE until phase-6 wires
// apps/api + apps/workers; the worker composes these with the injected enqueue + FileStore + rollup hook.
export { bulkStage, type BulkStageInput, type BulkStageResult } from "./import/bulkStage.ts";
export {
  bulkProcessChunk,
  type BulkProcessChunkInput,
  type BulkProcessChunkResult,
} from "./import/bulkProcessChunk.ts";
export {
  runBulkImport,
  finalizeIfLastChunk,
  chunkWindowLimit,
  continueChunkWindow,
  type EnqueueChunk,
  type RunBulkImportInput,
  type RunBulkImportResult,
  type FinalizeIfLastChunkInput,
  type FinalizeResult,
} from "./import/runBulkImport.ts";
// THE fast-vs-copy routing decision (import-redesign 08 §1; S-I5 pre-gate → S-I9 engagement): pure +
// env-free — the api passes the measured facts + the threshold knob + the copy-engagement verdict;
// over-threshold refuses honestly unless copy is engaged (15 §R-P2's standing fallback).
export {
  decideImportRouting,
  type ImportRoutingFacts,
  type ImportRoutingVerdict,
} from "./import/routing.ts";
// The ONE store-then-enqueue copy submission (import-redesign 08 §1.2 Phase C, S-I9): control row
// (processing_mode='copy') → stream the upload to the FileStore → enqueue the drive. Extracted from
// POST /imports/bulk so the bulk route is a thin delegate and the unified one-shot POST reuses it.
// Dependency-injected (FileStore + enqueue) like runBulkImport — core stays BullMQ/SDK-free.
export {
  copySourceExt,
  submitCopyImport,
  type SubmitCopyImportInput,
  type SubmitCopyImportResult,
} from "./import/submitCopyImport.ts";
// Tenant fairness for the unified import queue (import-redesign 09 §2, S-Q2): per-workspace job cap →
// `deferred` admission + the leader-locked sweep's per-workspace promotion pass. Knobs revert by env.
export {
  ACTIVE_IMPORT_STATUSES,
  decideFastAdmission,
  promoteDeferredForWorkspace,
  type FastAdmission,
  type PromotedImportJob,
} from "./import/importFairness.ts";
// Progress contract (import-redesign 09 §4, S-Q6): the counter-delta cadence constants + THE one
// derivation function feeding the poll response and, when wired, the SSE payloads + staff console.
export {
  IMPORT_PROGRESS_BATCH_ROWS,
  IMPORT_PROGRESS_MAX_DELTAS_PER_CHUNK,
  IMPORT_PROGRESS_MIN_INTERVAL_MS,
  deriveImportProgress,
  type DerivedImportProgress,
  type ImportProgressSource,
} from "./import/importProgress.ts";
export type { RawRow } from "./import/columnMap.ts";
// Fast-path dual-write wrapper (import-redesign 08 §1.2 Phase A / 09 §1.1, S-I3): durable state transitions +
// atomic counter deltas + the rejected-rows ledger AROUND the unchanged runImport. DARK while the
// IMPORT_V2_ENABLED dual gate is off (the api producer enqueues no `fast` jobs while gated).
export {
  runFastImport,
  markFastImportFailed,
  FastImportFailedError,
  type RunFastImportInput,
  type FastImportResult,
} from "./import/runFastImport.ts";
// Object-store seam (15-bulk-import-design §3/§4): the FileStore port the bulk pipeline writes through + a
// dev/test local-disk adapter. The prod S3 adapter is injected at the app composition root (kept out of core).
export { diskFileStore, type FileStore } from "./storage/fileStore.ts";
// Artifact/object lifecycle seam (import-redesign 13 §4.4, S-S7): the one job-object prefix + the
// hard-purge deleter every import purge path (retention deleter, S-S8 DSAR fan-out) composes.
export {
  importJobObjectPrefix,
  legacyRejectedRowsKey,
  purgeImportJobObjects,
} from "./import/artifactLifecycle.ts";
// Malware-scanner seam (import-redesign 13 §2, S-S2 — the G08/Gate C port): core declares the contract +
// the explicit stub default; the ClamAV clamd adapter lives in @leadwolf/integrations, env-selected at the
// api/workers composition roots (MALWARE_SCANNER=clamav|stub). Fail-closed on a real engine's error.
export {
  stubMalwareScanner,
  type MalwareScanResult,
  type MalwareScanSource,
  type MalwareScannerPort,
} from "./security/malwareScanner.ts";
// Data-quality validation engine (database-management-research 06) — the built-in + custom rules a prepared
// import row must pass (reject-on-fail). The DB-row custom rules are read by apps/api/apps/workers and passed in.
export {
  BUILTIN_VALIDATION_RULES,
  runValidationRules,
  type ValidationRuleSpec,
} from "./validation/index.ts";
// Knowledge-DB survivorship quality score (prospect-database-platform I1 / Phase 05) — pure cluster-quality v1.
export {
  computeClusterQualityScore,
  type ClusterQualityInput,
} from "./projection/computeQuality.ts";
// Unified ingestion connector framework (prospect-database-platform Phase 03 / I2) — the Connector port + registry.
export {
  type Connector,
  getConnector,
  registerConnector,
  registeredConnectorIds,
  registerBuiltinConnectors,
} from "./ingestion/index.ts";
export {
  saveMappingTemplate,
  listMappingTemplates,
  getMappingTemplate,
  applyMappingTemplate,
  deleteMappingTemplate,
  type SaveMappingTemplateInput,
} from "./import/templates.ts";
// The G02 "import at all" grant decision (import-redesign 10 §3, S-V4) — pure verdict; the api middleware
// maps it to 403 problems (insufficient_role / import_disabled_by_policy) behind the visibility dual gate.
export {
  evaluateImportCreateGrant,
  type ImportCreateGrantVerdict,
} from "./import/importCreateGrant.ts";
export { blindIndex } from "./import/blindIndex.ts";
export { encryptPii, decryptPii } from "./import/encryptPii.ts";
// Pre-commit validation preview + rejected-rows artifact + conflict policy (30 §4, ADR-0036; G-IMP-1/5).
export {
  validateRow,
  rejectedRowsFor,
  identitySignature,
  type RowVerdict,
  type RowRejectReason,
  type RowIdentity,
} from "./import/validateRow.ts";
export { buildImportPreview, type PreviewOptions } from "./import/preview.ts";
// S-I8 draft flow (08 §3.2/§4): the server-side auto-map alias table + the full-pass preview projection.
export { normalizeHeaderKey, suggestColumnMapping } from "./import/headerAliases.ts";
export {
  buildDraftPreviewSummary,
  type DraftPreviewOptions,
  type DraftPreviewResult,
} from "./import/draftPreview.ts";
export { rejectedRowsToCsv } from "./import/rejectedRowsCsv.ts";
// The S-I7 server-side artifact pair (repair CSV + taxonomy-grouped error report) + their deterministic keys.
export {
  buildRepairCsv,
  buildErrorReportCsv,
  writeImportArtifacts,
  repairArtifactKey,
  errorReportArtifactKey,
  neutralizeCell,
  redactValues,
  type ImportArtifactKeys,
} from "./import/artifactWriter.ts";

export { revealContact, revealCostFor, type RevealInput } from "./reveal/revealContact.ts";
// No-charge "view already-revealed data" reads (Phase 1 single + Phase 2 batch): decrypt ONLY the fields this
// workspace owns a reveal claim for, so already-revealed contacts show instantly without re-charging.
export { getRevealedContact, getRevealedContactsBatch } from "./reveal/getRevealedContact.ts";
// Customer own-workspace REVEALED CSV export (doc 12; audit A1, Phase 1) — reveals each contact THROUGH the gate
// (suppression-checked, charged, audited), excludes suppressed, writes the CSV through the FileStore port.
export {
  bulkRevealExport,
  type BulkRevealExportInput,
  type BulkRevealExportResult,
} from "./reveal/bulkRevealExport.ts";
// Async BULK REVEAL job (reveal-experience Phase 3, ADR-0029/0036) — create+estimate, the confirm/lease money
// gate, and the worker drive/chunk that reveals in `lease` settle-mode + finalizes with a release.
export {
  createRevealJob,
  confirmRevealJob,
  type CreateRevealJobInput,
  type CreateRevealJobResult,
} from "./reveal/bulk/createRevealJob.ts";
export {
  runBulkRevealDrive,
  bulkProcessRevealChunk,
  REVEAL_CHUNK_ROWS,
  type RunBulkRevealDriveInput,
  type BulkProcessRevealChunkInput,
  type EnqueueRevealChunk,
} from "./reveal/bulk/runBulkReveal.ts";
export {
  projectRevealEstimate,
  type RevealEstimate,
  type RevealCandidate,
} from "./reveal/bulk/estimate.ts";
// Staff cross-tenant export executor (doc 12; audit A1, Phase 2) — runs on a bulk_export approval under the owner
// tx; explicit-scope suppression filter + decrypt + CSV through the FileStore. Platform-audited, not credit-charged.
export {
  staffWorkspaceExport,
  type StaffWorkspaceExportInput,
  type StaffWorkspaceExportResult,
} from "./reveal/staffWorkspaceExport.ts";
export { assertNotSuppressed, type SuppressionKeys } from "./compliance/assertNotSuppressed.ts";
export { writeAudit, type AuditEntryInput } from "./compliance/writeAudit.ts";

// Workspace-admin session management (G-AUTH-2, 17 §5/§10): list/revoke/force-reauth, admin-gated + audited.
export {
  listMemberSessions,
  revokeMemberSession,
  forceReauthMember,
  type AdminSessionScope,
  type AdminSessionView,
} from "./auth/adminSessions.ts";

// Workspace members management (P1-03, 12 §3, 17 §5): list/invite/change-role/remove, admin-gated + audited.
export {
  listWorkspaceMembers,
  inviteMember,
  changeMemberRole,
  removeMember,
  type MemberAdminScope,
  type InviteMemberInput,
} from "./auth/members.ts";

export { createDsarRequest } from "./compliance/dsarIntake.ts";
export { deleteFanout, type DeleteFanoutResult } from "./compliance/deleteFanout.ts";
export { assembleAccessReport, type AccessReport } from "./compliance/assembleAccessReport.ts";
export { recordConsent, withdrawConsent, type WithdrawResult } from "./compliance/consent.ts";

export {
  enrichContact,
  type EnrichContactInput,
  type EnrichContactResult,
} from "./enrichment/enrichContact.ts";
export type {
  EnrichmentProvider,
  EnrichRequest,
  EnrichSubject,
  ProviderResult,
  ProviderFieldResult,
} from "./enrichment/providerPort.ts";
export { requestHash } from "./enrichment/requestHash.ts";
// Auto-enrich policy enforcement (G-ENR-1; 29 §3, 06 §4.1): the pure decision + the DB-backed guard the
// enrichment entry point consults before any system-initiated auto-enrich.
export {
  decideAutoEnrich,
  enforceAutoEnrichPolicy,
  type AutoEnrichDecision,
  type AutoEnrichDecisionInput,
  type AutoEnrichDenyReason,
} from "./enrichment/policy.ts";
export {
  runWaterfall,
  runWaterfallBulk,
  orderProviders,
  resetBreakers,
  type BulkWaterfallOptions,
} from "./enrichment/waterfall.ts";
export {
  registrableDomain,
  toE164,
  canonicalName,
  linkedinPublicId,
  buildMatchKeys,
  type MatchMethod,
  type MatchInputRow,
  type CanonicalNameResult,
  type MatchKeys,
} from "./enrichment/matchKeys.ts";

// Bulk match-first resolution (31 §5, ADR-0037): the MatchPort seam + overlay (real) / master-graph (stub)
// matchers + the sample-based cost estimate. DI-only — these never import @leadwolf/db (the worker wires it).
export type {
  MatchPort,
  MatchContext,
  MatchRowResult,
  Candidate,
  CandidateFinder,
} from "./enrichment/bulk/matchPort.ts";
export {
  createOverlayMatcher,
  type OverlayMatcherOptions,
} from "./enrichment/bulk/overlayMatcher.ts";
export { createMasterGraphMatcher } from "./enrichment/bulk/masterGraphMatcher.ts";
export {
  estimateBulkEnrich,
  worstCaseBulkEnrichMicros,
  type EstimateInput,
  type ProviderHitStats,
} from "./enrichment/bulk/estimate.ts";
// The bulk (existing-contact) re-enrich DRIVE (I3 slice 3a): chunk a CONFIRMED job's contact selection into bands
// + fan out chunk jobs. FREE (no provider calls); guarded on `running` so it never chunks an unconfirmed job.
export {
  runBulkEnrich,
  type EnqueueEnrichChunk,
  type RunBulkEnrichInput,
  type RunBulkEnrichResult,
} from "./enrichment/bulk/runBulkEnrich.ts";
// The bulk re-enrich CHUNK step (I3 slice 3b): re-enrich a band of existing contacts via enrichContact, braked by
// the per-run cap (the confirmed ceiling) + the inherited daily breaker. The only bulk slice that spends.
export {
  bulkProcessEnrichChunk,
  type BulkProcessEnrichChunkInput,
  type BulkProcessEnrichChunkResult,
} from "./enrichment/bulk/bulkProcessEnrichChunk.ts";

// Probabilistic entity resolution (I5): the pure Fellegi-Sunter scorer — comparison vector → match probability →
// review disposition. The candidate generator (blocking) + the SHADOW writer (match_links pending) are later slices.
export {
  scoreFellegiSunter,
  DEFAULT_FELLEGI_SUNTER_CONFIG,
  type FieldComparison,
  type FieldWeights,
  type FieldObservation,
  type MatchDisposition,
  type FellegiSunterConfig,
  type FellegiSunterResult,
} from "./er/fellegiSunter.ts";
export { jaro, jaroWinkler } from "./er/stringSimilarity.ts";
// The pure comparison layer (I5 slice 2): a candidate person PAIR → the Fellegi-Sunter observation vector.
export {
  compareRecords,
  DEFAULT_FIELD_WEIGHTS,
  type ComparablePerson,
} from "./er/compareRecords.ts";

// Customer-visible enrichment job-status surface (G-ENR-4, 06 §4.1): READ-only list/detail query helpers over
// the workspace-scoped enrichment-jobs repository → the EnrichmentJobSummary DTO the status UI polls.
export {
  listEnrichmentJobs,
  getEnrichmentJobStatus,
  toEnrichmentJobSummary,
  type ListEnrichmentJobsInput,
  type GetEnrichmentJobInput,
} from "./enrichment/jobStatus.ts";

// The human confirm-before-spend gate (I3 / audit A3/P08): the guarded awaiting_confirmation → running mutation
// that releases a bulk-enrich run only after a workspace admin accepts the persisted worst-case credit ceiling.
export {
  confirmBulkEnrichmentJob,
  type ConfirmBulkEnrichmentResult,
} from "./enrichment/confirmJob.ts";

export {
  passThroughVerifier,
  staticVerifier,
  hybridVerifier,
  type EmailVerifierPort,
} from "./data-health/emailVerifier.ts";
// Email-verification subsystem (06 §9, 01 §5.2): the Reacher adapter + the config-gated factory the reveal
// path wires. Absent REACHER_BACKEND_URL → passThroughVerifier (today's no-grading behaviour preserved).
export {
  reacherVerifier,
  defaultEmailVerifier,
  reacherStatusFrom,
  type ReacherVerifierOptions,
  type VerifierFetch,
} from "./data-health/reacherVerifier.ts";
// Local email pre-screen (06 §9): role/disposable short-circuit wrapped around the verifier to save paid probes.
export {
  localPrescreenVerifier,
  isRoleAccount,
  isDisposableDomain,
  ROLE_LOCAL_PARTS,
  DISPOSABLE_DOMAINS,
} from "./data-health/emailPrescreen.ts";
export { chargeFor, type ChargeInput } from "./data-health/chargeFor.ts";
export { validatePhone } from "./data-health/validatePhone.ts";
// Phone-verification subsystem (06 §9, 01 §5.3): the port + format-only default + the Twilio Lookup adapter +
// the config-gated factory the reveal/reverify paths wire. Absent TWILIO_* → the E.164 format check (today).
export {
  formatOnlyPhoneVerifier,
  staticPhoneVerifier,
  type PhoneVerifierPort,
  type PhoneVerifyResult,
} from "./data-health/phoneVerifier.ts";
export {
  twilioLookupVerifier,
  defaultPhoneVerifier,
  twilioStatusFrom,
  twilioLineTypeFrom,
  type TwilioPhoneVerifierOptions,
  type PhoneLookupFetch,
} from "./data-health/twilioPhoneVerifier.ts";
// Freshness re-verification loop (ADR-0025, 22 §3/§4): re-grades revealed, past-SLA contacts via the configured
// verifier, per workspace, off the request thread. Run by the reverification queue + sweep worker.
export {
  runReverification,
  recentReverificationRuns,
  REVERIFICATION_FLAG_KEY,
  type ReverificationResult,
} from "./data-health/reverifyContacts.ts";
// Per-workspace Data Health dashboard rollup (10 §5 / 22): the live fill/verification/freshness count aggregate.
export { buildDataQualitySummary } from "./data-health/dataQualitySummary.ts";
export {
  captureDataQualitySnapshot,
  recentDataQualityTrend,
} from "./data-health/dataQualitySnapshot.ts";
// Data quality & freshness keystone (22 §2–§3, ADR-0025): the 0–100 data_quality_score composite + cold-start
// re-weighting + completeness weights + verification sub-score + freshness SLAs/bands/decay. Pure + set-reusable;
// import-commit, the freshness sweep, and the masked DTO badge all wire it.
export {
  computeContactDataQuality,
  dataQualityScore,
  completenessSubScore,
  verificationSubScore,
  verificationMean,
  freshnessSubScore,
  freshnessStatusFor,
  ageDaysSince,
  COMPLETENESS_WEIGHTS,
  FRESHNESS_SLA_DAYS,
  COLD_START_FRESHNESS,
  type ContactQualityInput,
  type ContactQualityResult,
  type CompletenessField,
  type QualitySubScores,
  type FreshnessField,
} from "./data-health/dataQualityScore.ts";

export {
  computeScore,
  type ComputeScoreInput,
  type ComputeScoreResult,
} from "./scoring/computeScore.ts";
export { logActivity, type LogActivityInput } from "./activity/logActivity.ts";

// Sales Navigator assisted (HITL) capture (05 §5, M7, ADR-0009): a human pastes a link; we parse a dedup id
// and best-guess type, then dedup-insert. Never automates against LinkedIn.
export {
  captureSalesNavLink,
  type CaptureLinkInput,
  type CaptureLinkResult,
} from "./sales-navigator/captureLink.ts";
export { parseSalesNavLink, type ParsedSalesNavLink } from "./sales-navigator/parseLink.ts";

export {
  createSequence,
  addStep,
  type CreateSequenceInput,
  type AddStepInput,
  type AddStepResult,
} from "./outreach/createSequence.ts";
export {
  enrollContact,
  type EnrollContactInput,
  type EnrollContactResult,
} from "./outreach/enrollContact.ts";
export { sendStep, type SendStepInput, type SendStepResult } from "./outreach/sendStep.ts";
export {
  handleBounce,
  type HandleBounceInput,
  type HandleBounceResult,
} from "./outreach/handleBounce.ts";
export {
  consoleSender,
  staticSender,
  type EmailSenderPort,
  type OutboundEmail,
} from "./outreach/senderPort.ts";
// M12 email subsystem (email-planning/13 P0) — the net-new primitives + domain fns that EXTEND the M9 engine
// (D11): the KMS-envelope credential store (D7), the SPF/DKIM/DMARC verifier (DI resolver), and the
// mailbox-connect / sending-domain-create+verify orchestration over the @leadwolf/db email repositories.
export { encryptSecret, decryptSecret } from "./email/secretStore.ts";
export {
  verifyDomainAuth,
  nodeDnsResolver,
  type DnsResolverPort,
  type DomainAuthInputs,
  type DomainAuthResult,
} from "./email/dnsAuth.ts";
export {
  connectMailbox,
  type ConnectMailboxInput,
  type ConnectMailboxResult,
} from "./email/connectMailbox.ts";
export {
  createSendingDomain,
  verifySendingDomain,
  type CreateSendingDomainInput,
  type VerifySendingDomainInput,
  type VerifySendingDomainResult,
} from "./email/sendingDomains.ts";
// M12 P1 send-gate (email-planning/13 P1, D11): the ProviderAdapter seam, the per-tenant identity gate
// (D2/D3), the signed delivery/bounce webhook, and the dispatch that wraps the UNCHANGED M9 sendStep with
// the identity + send-quota gates. The concrete network adapters (SES/Gmail/Graph/SMTP) register in P1b.
export {
  registerAdapter,
  resolveSender,
  resetAdapters,
  type SendIdentity,
  type AdapterFactory,
} from "./email/providerAdapter.ts";
export { resolveSendingIdentity } from "./email/resolveSendingIdentity.ts";
export {
  verifyEmailWebhookSignature,
  signEmailWebhookPayload,
  parseDeliveryEvent,
  type DeliveryEvent,
  type DeliveryEventType,
} from "./email/deliveryWebhook.ts";
export {
  detectAutoReply,
  type ReplyClassification,
  type InboundHeaders,
} from "./email/detectAutoReply.ts";
export {
  recordInboundReply,
  defaultRecordInboundDeps,
  type ParsedInboundReply,
  type RecordInboundDeps,
  type RecordInboundResult,
} from "./email/recordInboundReply.ts";
export {
  parseGmailMessage,
  fetchInboundSince,
  fetchProfileHistoryId,
  fetchGmailReadPort,
  GmailReadError,
  type GmailReadPort,
  type ParsedGmailInbound,
} from "./email/gmailInbound.ts";
export {
  classifyReplyIfEnabled,
  REPLY_CLASSIFICATION_FLAG_KEY,
  type ReplyClassifierPort,
  type ReplyClassifierResult,
  type ClassifyReplyDeps,
} from "./email/replyClassifier.ts";
// P0 (email-sec-001): per-tenant derivation of the webhook/tracking signing keys from the root secret — a
// holder of one tenant's derived key cannot forge a signed event for another tenant.
export {
  deriveEmailSigningKey,
  type EmailSigningPurpose,
} from "./email/signingKeys.ts";
// M12 P1 mailbox OAuth (email-planning/13 P1, D1): the provider-agnostic connect seam + PKCE + the Google
// (Gmail) provider. authorize/exchange/refresh/revoke behind an injectable HTTP port; client secrets stay
// server-side. The connect-flow API resolves a provider from the registry; tokens are encrypted by secretStore.
export {
  generatePkce,
  pkceChallenge,
  randomState,
  type Pkce,
} from "./email/pkce.ts";
export {
  registerOAuthProvider,
  resolveOAuthProvider,
  resetOAuthProviders,
  fetchHttpPort,
  OAuthError,
  type MailboxOAuthProvider,
  type OAuthTokenBundle,
  type OAuthHttpPort,
  type OAuthIdentity,
  type AuthorizeParams,
} from "./email/oauthProvider.ts";
export {
  createGoogleOAuthProvider,
  GOOGLE_MAILBOX_SCOPES,
  type GoogleOAuthConfig,
} from "./email/googleOAuth.ts";
export {
  startMailboxConnect,
  completeMailboxConnect,
  type MailboxOAuthProviderId,
  type StartConnectInput,
  type StartConnectResult,
  type CompleteConnectOutcome,
} from "./email/mailboxConnectFlow.ts";
// M12 P1 Gmail send adapter (email-planning/13 P1, D1/D11): the RFC 5322 builder (stable Message-ID threading
// key + header-injection guard) and the gmail.messages.send adapter realizing the unchanged EmailSenderPort.
export {
  buildRfc822,
  generateMessageId,
  toGmailRaw,
  type Rfc822Input,
} from "./email/mimeMessage.ts";
export {
  createGmailSender,
  fetchGmailHttpPort,
  GmailSendError,
  type GmailHttpPort,
  type GmailSenderConfig,
} from "./email/gmailSend.ts";
export {
  getMailboxAccessToken,
  MailboxTokenError,
  type MailboxTokenScope,
} from "./email/mailboxTokenProvider.ts";
// Startup wiring (called by apps/api + apps/workers): registers the OAuth provider (connect+refresh) + the
// Gmail send adapter onto the M12 seams.
export { registerEmailProviders } from "./email/registerProviders.ts";
export {
  dispatchOutreachSend,
  type DispatchOutreachSendInput,
} from "./email/dispatchOutreachSend.ts";
// M12 P1 outbound persistence (email-planning/13 P1, D11): record the sent message into the conversation store
// (find-or-create thread + outbound email_message w/ the rfc822 Message-ID) — best-effort, after sendStep.
export {
  recordOutboundMessage,
  normalizeSubject,
  type RecordOutboundInput,
  type RecordOutboundResult,
} from "./email/recordOutboundMessage.ts";
// M12 P1 per-mailbox send-rate throttle (WARM-001): the pure token-bucket + the injectable port (default
// allow-all; apps/workers injects the Redis adapter). A throttled send is deferred (re-enqueued), never dropped.
export {
  consumeToken,
  type BucketState,
  type BucketConfig,
  type BucketResult,
} from "./email/tokenBucket.ts";
export {
  allowAllThrottle,
  MailboxThrottledError,
  type MailboxThrottlePort,
  type ThrottleResult,
} from "./email/mailboxThrottle.ts";
// M12 P1 proactive token refresh (leader-locked sweep): refresh mailboxes nearing OAuth expiry off the send path.
export {
  refreshDueMailboxTokens,
  type RefreshSweepResult,
  type RefreshSweepDeps,
} from "./email/refreshDueMailboxTokens.ts";
// M12 P2 templates (email-planning/13 P2, 01): the render-safe engine (the injection boundary) + the
// versioned, owner-scoped (D8) template CRUD that externalises the inline outreach_steps.body.
export {
  renderTemplate,
  extractVariables,
  type RenderOptions,
} from "./email/renderTemplate.ts";
export {
  createTemplate,
  updateTemplate,
  listTemplates,
  getTemplate,
  listTemplateVersions,
  previewTemplate,
  restoreVersion,
  TEMPLATE_MERGE_FIELDS,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type TemplateSummary,
  type TemplateDetail,
  type TemplateVersion,
  type PreviewTemplateInput,
  type RestoreVersionInput,
} from "./email/templates.ts";
// M12 P3 tracking (email-planning/13 P3, 04): the signed open/click token + the email_event → activities
// projection that lights up the per-contact timeline (idempotent; opens informational, D6).
export {
  signTrackingToken,
  verifyTrackingToken,
  signTrackingTokenScoped,
  verifyTrackingTokenScoped,
  type TrackingTokenPayload,
} from "./email/trackingToken.ts";
export {
  ingestTrackingEvent,
  type TrackingEventInput,
} from "./email/ingestTrackingEvent.ts";
// M12 P4 sequence automation (email-planning/13 P4, 15 §A.4): the leader-locked tick body — claims due
// enrollments (FOR UPDATE SKIP LOCKED, no double-advance) + auto-pause-on-reply (replied rows aren't claimed).
export {
  tickSequences,
  type TickResult,
  type TickOptions,
} from "./email/sequenceScheduler.ts";
// M12 P5 deliverability + analytics + warmup (email-planning/13 P5, 08): the workspace deliverability report
// (reply rate primary, opens informational — D6) + the pure warmup ramp schedule.
export {
  computeDeliverability,
  type DeliverabilityReport,
} from "./email/deliverabilityAnalytics.ts";
export {
  warmupDailyTarget,
  isWarmupComplete,
  type WarmupSchedule,
} from "./email/warmup.ts";
// M12 P6 platform governance (email-planning/13 P6, 06/11): global suppression + per-tenant send-quota, both
// on the audited withPlatformTx path (platform-staff only). Reuse suppression_list / tenants (D11).
export {
  addGlobalSuppression,
  setTenantEmailSendQuota,
  type AddGlobalSuppressionInput,
} from "./email/governance.ts";
export { grantFromStripe } from "./billing/grantFromStripe.ts";
export { handleSubscriptionEvent } from "./billing/handleSubscriptionEvent.ts";
export {
  verifyStripeSignature,
  signStripePayload,
  parseCreditGrantEvent,
  type CreditGrantEvent,
  parseSubscriptionEvent,
  type SubscriptionEvent,
} from "./billing/stripeWebhook.ts";
export {
  StripeError,
  type StripePort,
  type CheckoutSession,
  type CreateCheckoutInput,
  type StripeSubscription,
} from "./billing/stripePort.ts";
export { buildHomeSummary, type BuildHomeSummaryInput } from "./home/buildHomeSummary.ts";

// Workspace pipeline-stage layer (G-REV-7, ADR-0028): author/edit stages mapping to a canonical
// outreach_status, and assign a contact → roll its outreach_status up to the stage's mapping in one tx.
export {
  createStage,
  updateStage,
  assignStage,
  type CreateStageInput,
  type UpdateStageInput,
  type AssignStageInput,
  type AssignStageResult,
} from "./pipelineStages/manageStages.ts";
// AI intelligence layer (23, ADR-0023): the AiPort seam + NL→structured-search compilation with the
// prompt-injection guard + per-tenant budget guard. DI-only — core OWNS the port; the Anthropic adapter
// (packages/integrations) implements it; core never imports integrations.
export type { AiPort, SearchSchemaContext, ParseSearchResult, AiCallUsage } from "./ai/aiPort.ts";
export { AiParseError } from "./ai/aiPort.ts";
export {
  compileSearchQuery,
  buildSearchSchemaContext,
  AiInputRejectedError,
  type CompileSearchQueryInput,
} from "./ai/compileSearchQuery.ts";
export { sanitizeNlQuery, looksLikeInjection } from "./ai/promptGuard.ts";
export {
  reserveAiBudget,
  releaseAiBudget,
  createInMemoryBudgetStore,
  utcDayKey,
  AiBudgetExceededError,
  type AiBudgetStore,
} from "./ai/budgetGuard.ts";
// Outbound webhooks (09 §10, 26 §4, G-INT-5): create/sign/dispatch/replay with an SSRF guard. The signing
// scheme is the same HMAC-SHA256 as the inbound Stripe verifier (billing/stripeWebhook.ts).
export {
  createWebhookSubscription,
  sendTestEvent,
  replayDelivery,
  SsrfError,
  type CreateSubscriptionInput,
  type CreateSubscriptionResult,
  type SendTestEventInput,
  type ReplayDeliveryInput,
  type ReplayOutcome,
} from "./webhooks/webhooks.ts";
export {
  dispatchToSubscription,
  type DispatchInput,
  type DispatchResult,
} from "./webhooks/dispatch.ts";
export {
  signWebhookPayload,
  generateSigningSecret,
  secretPrefixOf,
  encryptSigningSecret,
  decryptSigningSecret,
} from "./webhooks/sign.ts";
export { assertSafeWebhookUrl, isBlockedAddress } from "./webhooks/ssrfGuard.ts";
// Platform feature flags (13 §3.5, ADR-0011): the pure evaluation rule + the DB-backed read helpers.
export { evaluateFlag, isFlagEnabled, type FlagState } from "./featureFlags/evaluateFlag.ts";
export {
  evaluateFlagsForTenant,
  evaluateFlagForTenant,
  isFlagEnabledForTenant,
} from "./featureFlags/flagsForTenant.ts";
// Record-customization tag layer (ADR-0028, G-REV-6): workspace-scoped tags + record assignments. Tag
// mutations are audit-free for now (no tag.* action in the 08 §5 closed enum) — follow-up to add them.
export {
  createTag,
  updateTag,
  deleteTag,
  assignTag,
  unassignTag,
  TagNameConflictError,
  type CreateTagInput,
  type UpdateTagInput,
  type AssignTagInput,
} from "./prospect/tags.ts";
// Field-provenance pin SETTER (PLAN_03 §1.4): a user hand-edit always wins and pins the edited scalar fields
// so future enrichment won't overwrite them (the enrichment write side is pin-aware in enrichContact).
export {
  editContactFields,
  type ContactFieldEdits,
} from "./prospect/editContact.ts";

// Search query-semantics layer (24 §4, ADR-0035): title canonicalization + synonym/abbreviation expansion.
export { normalizeTitle } from "./search/normalizeTitle.ts";
export {
  canonicalizeTitle,
  findCanonicalTitle,
  type CanonicalizedTitle,
} from "./search/canonicalizeTitle.ts";
export { expandTitleTerm } from "./search/expandQuery.ts";
export { planTitleFilter, type TitleFilterPlan } from "./search/planTitleFilter.ts";
export { CANONICAL_TITLES, type CanonicalTitle } from "./search/titleTaxonomy.ts";

// Saved searches / segments (M8, 24 §8): persist + re-apply the validated contactQuery blob; owner-gated
// mutations; private-vs-workspace visibility.
export {
  createSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  deleteSavedSearch,
  type CreateSavedSearchInput,
  type UpdateSavedSearchInput,
  type DeleteSavedSearchInput,
} from "./savedSearches/savedSearches.ts";
// Static prospect lists (24, bulk add-to-list): workspace-shared collections; owner-gated rename/delete;
// cross-workspace-safe membership writes returning an affected count.
export {
  createList,
  createDynamicList,
  listLists,
  listListMembers,
  assertListInWorkspace,
  updateList,
  deleteList,
  addContactsToList,
  addContactsToNewList,
  removeContactsFromList,
  type CreateListInput,
  type CreateDynamicListInput,
  type UpdateListInput,
  type DeleteListInput,
  type AddToListInput,
  type AddToNewListInput,
  type RemoveFromListInput,
  type ListMembersInput,
  type ListMember,
  type ListMembershipResult,
  type AssertListInput,
} from "./prospect/lists.ts";
// Phase-3 bulk actions over the prospect search results (24): owner assign/reassign (policy-gated), bulk tags
// (add/remove), bulk status, bulk archive (soft), bulk enroll, bulk enrich (enqueue), role-gated CSV export, and
// the select-all-across-search count. Each is workspace-scoped, visible-id-filtered, affected-count, audited
// where the closed 08 §5 enum has an action.
export {
  assignOwner,
  bulkAssignTags,
  bulkRemoveTags,
  bulkChangeStatus,
  bulkArchive,
  bulkEnroll,
  bulkEnrich,
  bulkExportCsv,
  searchCount,
  estimateBulkSpend,
  type BulkSelectionInput,
  type BulkAssignOwnerInput,
  type BulkTagsInput,
  type BulkStatusInput,
  type BulkEnrollInput,
  type BulkEnrichInput,
  type BulkExportInput,
  type BulkEstimateInput,
} from "./prospect/bulkActions.ts";
// Company-level (accounts) search count (24/ADR-0035): the firmographic sibling of searchCount. Thin delegate
// to the @leadwolf/db accountSearchRepository (no query-semantics layer needed for accounts).
export { searchAccountsCount } from "./prospect/accountSearch.ts";
// Within-workspace dedup REVIEW (database-management-research G09): list the auto-flagged duplicate pairs + override
// a wrong call. Workspace-scoped (RLS); names only, no PII decrypt.
export {
  listContactDuplicatePairs,
  unmarkContactDuplicate,
} from "./prospect/dedupReview.ts";
// Master-link backfill (PLAN_00 §11.5 / PLAN_07 Stage B): the existing-data complement to the Phase-2′ import
// resolution — re-resolves overlay contacts with NULL master_* bridges through the ONE resolver (ADR-0037),
// per-workspace, batched + idempotent. Run by the master-backfill queue worker.
export {
  runMasterBackfill,
  type MasterBackfillResult,
} from "./prospect/backfillMaster.ts";
// Contact dedup pass (24 Phase-0.5): flags likely-duplicate contacts (name+domain key) by writing
// duplicate_of_contact_id → the canonical, powering the duplicate search facet. Soft (pointer only), per-
// workspace (RLS), idempotent — run by the dedup queue worker.
export {
  runDedup,
  computeDuplicateGroups,
  pickCanonical,
  completenessScore,
  dedupKey,
  type DuplicateGroup,
  type RunDedupResult,
} from "./prospect/dedup.ts";
// Firmographics rollup (24 Phase-0.5): surfaces existing intent_signals (tech_install/funding_round) onto the
// account firmographic facets so the technographic/funding filters aren't empty. Run by the firmographics worker.
export {
  runFirmographicRollup,
  aggregateFirmographics,
  normalizeTech,
  type AccountFirmographics,
  type RunFirmographicRollupResult,
} from "./prospect/firmographics.ts";

// Record customization (custom fields — ADR-0028, gap G-REV-5): registry CRUD + typed-jsonb value set/get +
// the pure type validator (reused by import mapping later).
export {
  validateValue,
  type FieldDefinitionForValidation,
} from "./customFields/validateValue.ts";
export {
  createDefinition,
  updateDefinition,
  listDefinitions,
  type CreateDefinitionInput,
  type UpdateDefinitionInput,
} from "./customFields/manageDefinitions.ts";
export {
  setCustomFieldValues,
  getCustomFieldValues,
  type SetValuesInput,
} from "./customFields/setValues.ts";

// Per-data-class retention engine — per-tenant sweep (data-management backlog #6; design
// 16-retention-engine-design.md). Per tenant: gate on the per-tenant engine flag, then per eligible v1 class COUNT
// candidate rows, PURGE them only when the class is in `enforce` mode (double-gated: flag + per-class enforce; ships
// INERT), and append a retention_runs evidence row. Run by the leader-locked daily dataRetentionSweep worker.
export {
  runRetentionSweepForTenant,
  type RetentionSweepResult,
} from "./retention/runRetentionSweep.ts";

// Multi-value channel dual-write (import-and-data-model-redesign 05, S-CH2): the dual-gate evaluator
// (CHANNEL_DUAL_WRITE env + `channels_dual_write` per-tenant flag, fail-closed) + the phone channel-value
// builder (DM1: shipped toE164/blindIndex/encryptPii, zero new normalizers). The write path itself is
// @leadwolf/db's contactChannelRepository.applyChannelWrite (CH-INV-1's single sanctioned writer).
export {
  isChannelDualWriteEnabled,
  channelDualWriteEnabledForScope,
  buildPhoneChannelValue,
  countryHintOf,
  phoneRawIndexForm,
  type BuildPhoneChannelInput,
} from "./channels/channelDualWrite.ts";

// S-CH3 channel backfill (import-and-data-model-redesign 15 §2.1): the per-workspace runner — withTenantTx
// keyset batches (email bytes verbatim, phones decrypt→E.164 in-worker), WHERE-missing selection as the
// watermark, the dual gate re-checked per batch as the abort. Driven by apps/workers' leader-locked
// channelBackfillSweep; the completeness count (the S-CH4 gate) is contactChannelRepository's.
export {
  planContactChannelBackfill,
  runChannelBackfillForWorkspace,
  type ChannelBackfillOptions,
  type ChannelBackfillWorkspaceResult,
  type ContactChannelBackfillPlan,
} from "./channels/channelBackfill.ts";
