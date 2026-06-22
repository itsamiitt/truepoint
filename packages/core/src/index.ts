// Public surface of @leadwolf/core — domain logic shared by apps/api and apps/workers. M1 exposes the
// import pipeline + the PII/dedup primitives; M3 adds the money loop (reveal transaction, suppression
// gate, audit writer, Stripe grant). Internals (normalize, contentHash, columnMap) stay private; import
// them relatively from within the package (incl. co-located tests).

export { runImport, type RunImportInput } from "./import/runImport.ts";
export { parseImportFile, parseCsv, type ParsedCsv } from "./import/parseFile.ts";
export type { RawRow } from "./import/columnMap.ts";
export {
  saveMappingTemplate,
  listMappingTemplates,
  getMappingTemplate,
  applyMappingTemplate,
  deleteMappingTemplate,
  type SaveMappingTemplateInput,
} from "./import/templates.ts";
export { blindIndex } from "./import/blindIndex.ts";
export { encryptPii, decryptPii } from "./import/encryptPii.ts";
// Pre-commit validation preview + rejected-rows artifact + conflict policy (30 §4, ADR-0036; G-IMP-1/5).
export {
  validateRow,
  rejectedRowsFor,
  identitySignature,
  type RowVerdict,
  type RowIdentity,
} from "./import/validateRow.ts";
export { buildImportPreview, type PreviewOptions } from "./import/preview.ts";
export { rejectedRowsToCsv } from "./import/rejectedRowsCsv.ts";

export { revealContact, revealCostFor, type RevealInput } from "./reveal/revealContact.ts";
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
  type EstimateInput,
  type ProviderHitStats,
} from "./enrichment/bulk/estimate.ts";

// Customer-visible enrichment job-status surface (G-ENR-4, 06 §4.1): READ-only list/detail query helpers over
// the workspace-scoped enrichment-jobs repository → the EnrichmentJobSummary DTO the status UI polls.
export {
  listEnrichmentJobs,
  getEnrichmentJobStatus,
  toEnrichmentJobSummary,
  type ListEnrichmentJobsInput,
  type GetEnrichmentJobInput,
} from "./enrichment/jobStatus.ts";

export {
  passThroughVerifier,
  staticVerifier,
  type EmailVerifierPort,
} from "./data-health/emailVerifier.ts";
export { chargeFor, type ChargeInput } from "./data-health/chargeFor.ts";
export { validatePhone } from "./data-health/validatePhone.ts";

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
export { grantFromStripe } from "./billing/grantFromStripe.ts";
export {
  verifyStripeSignature,
  signStripePayload,
  parseCreditGrantEvent,
  type CreditGrantEvent,
} from "./billing/stripeWebhook.ts";
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
export type { AiPort, SearchSchemaContext, ParseSearchResult } from "./ai/aiPort.ts";
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
  listLists,
  updateList,
  deleteList,
  addContactsToList,
  addContactsToNewList,
  removeContactsFromList,
  type CreateListInput,
  type UpdateListInput,
  type DeleteListInput,
  type AddToListInput,
  type AddToNewListInput,
  type RemoveFromListInput,
  type ListMembershipResult,
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
  type BulkSelectionInput,
  type BulkAssignOwnerInput,
  type BulkTagsInput,
  type BulkStatusInput,
  type BulkEnrollInput,
  type BulkEnrichInput,
  type BulkExportInput,
} from "./prospect/bulkActions.ts";
// Company-level (accounts) search count (24/ADR-0035): the firmographic sibling of searchCount. Thin delegate
// to the @leadwolf/db accountSearchRepository (no query-semantics layer needed for accounts).
export { searchAccountsCount } from "./prospect/accountSearch.ts";
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
