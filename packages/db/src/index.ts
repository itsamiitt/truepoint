// Public surface of @leadwolf/db — the tenancy-scoped client + the auth-domain repositories. Repositories
// are the ONLY data-access layer; callers import them from here, never the schema or client internals.
export {
  db,
  withTenantTx,
  withPrivilegedTx,
  withErTx,
  withPlatformTx,
  withPlatformReadTx,
  recordPlatformEvent,
  type PlatformEventInput,
  closeDb,
  type Db,
  type Tx,
  type TenantScope,
  type PlatformActor,
  type PlatformAuditTarget,
} from "./client.ts";
export {
  provisionBootstrapAdmin,
  type BootstrapAdminInput,
  type BootstrapAdminResult,
} from "./bootstrapAdmin.ts";
export * as schema from "./schema/index.ts";
export {
  userRepository,
  sessionRepository,
  authEmailTokenRepository,
  type UserRecord,
  type SessionRecord,
  type AdminSessionRecord,
  type OwnSessionRecord,
  type CreateSessionInput,
  type MfaMethodRecord,
  type DetailedMfaMethodRecord,
  type CreateEmailTokenInput,
} from "./repositories/userRepository.ts";
export {
  workspaceRepository,
  tenantMemberRepository,
  tenantDomainRepository,
  tenantRepository,
  type TenantBillingProfile,
  tenantSsoConfigRepository,
  invitationRepository,
  type WorkspaceSummary,
  type WorkspaceMemberRecord,
  type TenantMembership,
  type ScimMemberRow,
  type DomainResolution,
  type SsoConfigRecord,
  type PendingInvitation,
  type InvitationByToken,
  type CreateInvitationInput,
} from "./repositories/workspaceRepository.ts";
export {
  accountRepository,
  type AccountFirmographicsPatch,
  type AccountUpsertInput,
} from "./repositories/accountRepository.ts";
// Company-overlay child write path (import-and-data-model-redesign 06 §1/§3, S-A2 dual-write + S-A1/S-A3
// backfills) — the accounts sibling of contactChannelRepository: `applyAccountDomainWrite` (child + flat
// accounts.domain cache in one withTenantTx) plus the WHERE-missing backfill selection/insert/census/count.
export {
  accountChildRepository,
  type AccountChildScope,
  type AccountDomainValue,
  type AccountDomainWriteOp,
  type AccountDomainWriteOutcome,
  type BackfillAccountChildResult,
  type MissingAccountDomainRow,
  type MissingAccountHqRow,
} from "./repositories/accountChildRepository.ts";
export {
  planAccountDomainWrite,
  type AccountDomainUpsertState,
  type AccountDomainVerdict,
} from "./repositories/accountChildPlan.ts";
// Layer-0 master graph (ADR-0021; prospect-company-data PLAN_01 §4) — deterministic MATCH-AGAINST resolve-for-
// import. Reads/co-op-safe-mints the system-owned golden graph; always run within withErTx (the leadwolf_er role).
export {
  masterGraphRepository,
  type ResolveForImportInput,
  type ResolveForImportResult,
} from "./repositories/masterGraphRepository.ts";
// Probabilistic ER (I5) system reads over the master graph — candidate generation via blocking (withErTx; read-only).
export {
  erRepository,
  ER_CANDIDATE_LIMIT,
  type ErCandidatePerson,
} from "./repositories/erRepository.ts";
export {
  customFieldRepository,
  type CustomFieldValue,
  type CustomFieldDefinitionInsert,
  type CustomFieldDefinitionUpdate,
  type CustomFieldDefinitionRecord,
} from "./repositories/customFieldRepository.ts";
export {
  contactRepository,
  type ContactWriteValues,
  type DedupContactRow,
  type DedupKeys,
  type DuplicatePairRow,
  type EnrichEstimateSignal,
  type HotLeadRow,
  type UnresolvedContactRow,
} from "./repositories/contactRepository.ts";
export {
  contactChannelRepository,
  type BackfillContactChannelsResult,
  type BackfillEmailChild,
  type BackfillPhoneChild,
  type ChannelWriteOp,
  type ChannelWriteOutcome,
  type ChannelDriftRow,
  type ChannelWriteScope,
  type EmailBlindIndexHit,
  type EmailChannelValue,
  type LiveEmailChannelRow,
  type LivePhoneChannelRow,
  type MissingChannelProjectionRow,
  type PhoneChannelValue,
  type ReconcileEmailRow,
  type ReconcilePhoneRow,
} from "./repositories/contactChannelRepository.ts";
export {
  planChannelUpsert,
  type ChannelUpsertState,
  type ChannelUpsertVerdict,
} from "./repositories/contactChannelPlan.ts";
export {
  verificationJobRepository,
  type VerificationJobRecord,
  type VerificationJobRow,
} from "./repositories/verificationJobRepository.ts";
export {
  dataQualitySnapshotRepository,
  type DataQualitySnapshotRow,
} from "./repositories/dataQualitySnapshotRepository.ts";
// Retention engine control plane (data-management backlog #6; design 16-retention-engine-design.md) — the GLOBAL
// policy store + the per-tenant, append-only run audit. No deletion logic yet (the sweep lives in core/workers, a
// later phase); this is purely the policy/run store. Policies are platform-managed (app reads via a SELECT-only
// RLS policy; writes are owner/withPlatformTx only); runs compose inside withTenantTx (tenant-scoped, append-only).
export { retentionClassPolicyRepository } from "./repositories/retentionClassPolicyRepository.ts";
export {
  retentionRunRepository,
  type RetentionRunRow,
  type RetentionRunInsert,
  type RecentRunsOptions,
} from "./repositories/retentionRunRepository.ts";
// Global data-quality validation rules (database-management-research 06) — the import-enforcement read (app
// SELECT-only RLS; staff author them via withPlatformTx in the admin rule-builder).
export {
  validationRuleRepository,
  type ImportValidationRule,
} from "./repositories/validationRuleRepository.ts";
// Evidence substrate writers (prospect-database-platform I0 / audit P01) — append-only source_records + match_links;
// the survivorship projection (Phase 05) reads them. Additive; wired behind INGESTION_EVIDENCE_ENABLED.
export {
  evidenceRepository,
  type SourceRecordInput,
  type MatchLinkInput,
} from "./repositories/evidenceRepository.ts";
// Survivorship projector data access (prospect-database-platform I1 / Phase 05) — drains projection_outbox + writes
// the shadow seams (data_quality_score, prov_hwm) on the golden row; NEVER the authoritative scalar columns.
export {
  projectorRepository,
  type PendingProjection,
  type ClusterEvidenceSummary,
} from "./repositories/projectorRepository.ts";
// Transactional outbox (ADR-0027; worker-platform Phase 3) — the publish intent commits atomically with the
// business transition (write side, tenant tx) and the workers relay drains it leaderlessly (SKIP LOCKED, owner).
export {
  outboxRepository,
  MAX_PUBLISH_ATTEMPTS,
  type OutboxEnqueue,
  type ClaimedOutboxRow,
} from "./repositories/outboxRepository.ts";
// Retention SHADOW sweep COUNT layer (data-management backlog #6, phase 2) — the per-class candidate counter (a
// cross-tenant OWNER read with an explicit tenant predicate; COUNTS only, no deletion) + the fixed table/aging/
// scope META phase 3's deleters reuse + the active-tenant fleet enumeration the sweep fans out over.
export {
  retentionScanRepository,
  retentionClassMeta,
  isRetentionV1Class,
  RETENTION_V1_CLASSES,
  type RetentionV1Class,
  type RetentionClassMeta,
  type RetentionTenantScope,
  type OwnerReader,
} from "./repositories/retentionScanRepository.ts";
export {
  sourceImportRepository,
  type SourceImportInput,
  type ImportBatchRow,
} from "./repositories/sourceImportRepository.ts";
export {
  tagRepository,
  type TagRow,
  type TagInsert,
  type TagUpdate,
  type AssignInput,
} from "./repositories/tagRepository.ts";
export {
  revealRepository,
  type ContactForReveal,
  type RevealClaimInput,
  type RevealUsageRow,
  type UsageFilter,
  type UsageListOptions,
} from "./repositories/revealRepository.ts";
export {
  creditRepository,
  type GrantInput,
  type GrantResult,
  type BurnByDayRow,
  type LedgerEntryType,
  type LedgerEntryInput,
  type CustomerLedgerRow,
} from "./repositories/creditRepository.ts";
export {
  suppressionRepository,
  type SuppressionKeys,
  type SuppressionHit,
  type SuppressionEntryInput,
} from "./repositories/suppressionRepository.ts";
export {
  auditRepository,
  type AuditEntryInput,
  type ActivityFeedRow,
  type AuthAuditRow,
} from "./repositories/auditRepository.ts";
// Tenant auth policy (ADR-0018) — the Auth Admin Security & Access record (tenant-scoped, audited).
export { authPolicyRepository } from "./repositories/authPolicyRepository.ts";
export {
  idempotencyRepository,
  type StoredResponse,
} from "./repositories/idempotencyRepository.ts";
export {
  scoreRepository,
  type ScoreInsert,
  type ScoreHistoryRow,
} from "./repositories/scoreRepository.ts";
export {
  intentSignalRepository,
  type FirmographicSignalRow,
  type IntentSignalInsert,
  type IntentSignalRow,
} from "./repositories/intentSignalRepository.ts";
export {
  providerCallRepository,
  type ProviderCallRecord,
  type CachedCall,
  type EnrichActivityRow,
} from "./repositories/providerCallRepository.ts";
export { consentRepository, type ConsentInsert } from "./repositories/consentRepository.ts";
export {
  dsarRequestRepository,
  dsarFanoutRepository,
  type DsarCreateInput,
  type DsarRow,
  type SubjectCopy,
} from "./repositories/dsarRepository.ts";
export {
  activityRepository,
  type ActivityInsert,
  type ActivityTimelineRow,
  type ActivityCounts,
} from "./repositories/activityRepository.ts";
export {
  salesNavLinkRepository,
  type SalesNavLinkInsert,
  type SalesNavLinkRecord,
  type SalesNavInsertResult,
} from "./repositories/salesNavLinkRepository.ts";
export {
  sequenceRepository,
  type SequenceInsert,
  type SequenceRecord,
  type StepInsert,
  type StepRecord,
  type SequenceSummaryRow,
  type PerformanceSnapshotRow,
} from "./repositories/sequenceRepository.ts";
export {
  outreachLogRepository,
  type EnrollmentInsert,
  type EnrollmentRecord,
  type LogWithSequence,
  type OutreachLogRow,
} from "./repositories/outreachLogRepository.ts";
// The ONE job-visibility predicate (import-redesign 10 §4) — applied inside every user-facing job list/get
// repository method; exported for the repo layer and its tests (routes NEVER assemble the predicate).
export {
  jobVisibility,
  creatorVisibility,
  type JobVisibilityColumns,
} from "./repositories/jobVisibility.ts";
export {
  enrichmentJobRepository,
  type JobCreateValues,
  type JobRecord,
  type JobViewRow,
  type JobStatusUpdate,
  type JobProgressDelta,
  type ChunkCreateValues,
  type ChunkUpdate,
  type ChunkRecord,
  type JobRowInsert,
  type JobRowRecord,
  type ContactMatchKeys,
  type ContactMatchCandidate,
} from "./repositories/enrichmentJobRepository.ts";
// Async bulk-reveal job control plane (reveal-experience Phase 3) — reveal_jobs / reveal_job_rows lifecycle:
// idempotent create, atomic counters, the status-pinned confirm gate, band reads, retry-failed re-queue.
export {
  revealJobRepository,
  type RevealJobCreateValues,
  type RevealJobRecord,
  type RevealJobViewRow,
  type RevealJobStatusUpdate,
  type RevealJobProgressDelta,
  type RevealBandRow,
  type ConfirmRevealJobResult,
} from "./repositories/revealJobRepository.ts";
// Domain-event transactional outbox (reveal-experience Phase 4, ADR-0027) — append in the state-change tx;
// the relay drains + publishes to Redis pub/sub for the SSE gateway.
export {
  eventOutboxRepository,
  type OutboxEventInput,
  type OutboxEventRow,
} from "./repositories/eventOutboxRepository.ts";
// Bulk COPY-staging import control plane (15-bulk-import-design, backlog #2) — the import_jobs / _chunks / _rows
// lifecycle CRUD; tx-aware, composed inside withTenantTx (RLS workspace isolation; chunks inherit via parent).
export {
  importJobRepository,
  type ImportJobRow,
  type ImportJobChunkRow,
  type ImportJobLedgerRow,
  type ImportJobCreateValues,
  type ImportJobStatusUpdate,
  type ImportJobProgressDelta,
  type ImportChunkCreateValues,
  type ImportChunkUpdate,
  type ImportJobRowInsert,
} from "./repositories/importJobRepository.ts";
// Per-job UNLOGGED, NON-RLS COPY-staging table (15-bulk-import-design §1/§2) — ALL on the owner connection
// (COPY can't run on an RLS table); isolated by an explicit workspace_id predicate, confined to this repository.
export {
  importStagingRepository,
  type StagingRow,
} from "./repositories/importStagingRepository.ts";
export {
  pipelineStageRepository,
  type StageCreateValues,
  type StageUpdateValues,
  type StageRecord,
} from "./repositories/pipelineStageRepository.ts";
export {
  savedSearchRepository,
  type SavedSearchRow,
  type SavedSearchInsert,
} from "./repositories/savedSearchRepository.ts";
export {
  listRepository,
  type ListRow,
  type ListInsert,
  type AddMembersInput,
  type ListMembersResultPage,
} from "./repositories/listRepository.ts";
export {
  searchRepository,
  type SearchResultPage,
} from "./repositories/searchRepository.ts";
export { accountSearchRepository } from "./repositories/accountSearchRepository.ts";
export {
  enrichmentPolicyRepository,
  type EnrichmentPolicyRecord,
  type EnrichmentPolicyUpsert,
  type EnrichmentPolicyPatch,
} from "./repositories/enrichmentPolicyRepository.ts";
// Per-workspace import policy (import-redesign 10 §3, S-V4; G02) — the who_can_import grant knob +
// the 08 §5 strategy defaults. Tx-aware upsert so the settings PUT audits in the same transaction.
export {
  importPolicyRepository,
  type ImportPolicyRecord,
  type ImportPolicyUpsert,
} from "./repositories/importPolicyRepository.ts";
// P5 scheduled imports (import-redesign 08 §9) — workspace-scoped CRUD + the sweep's system-level due census.
export {
  scheduledImportRepository,
  type ScheduledImportRow,
  type ScheduledImportCreateValues,
  type ScheduledImportUpdateValues,
  type DueSchedule,
} from "./repositories/scheduledImportRepository.ts";
// Platform super-admin read surface (ADR-0032) — bounded cross-tenant reads, run within withPlatformTx.
export {
  platformAdminRepository,
  PLATFORM_READ_LIMIT,
  type PlatformPage,
  type PlatformTenantRow,
  type PlatformTenantDetail,
  type PlatformTenantOverview,
  type PlatformWorkspaceRow,
  type PlatformWorkspaceListRow,
  type PlatformListOverviewRow,
  type PlatformMemberRow,
  type PlatformUserRow,
  type PlatformImportJobRow,
  type PlatformRetentionRunRow,
} from "./repositories/platformAdminReads.ts";
// Platform super-admin WRITE surface (13a Area 1) — audited cross-tenant mutations, run within withPlatformTx.
export {
  platformAdminWriteRepository,
  type TenantLifecycleStatus,
  type CreditAdjustOutcome,
  type UserAccountStatus,
  type UserStatusOutcome,
  type RefundOutcome,
} from "./repositories/platformAdminWrites.ts";
// Platform STAFF role lookup (ADR-0011) — owner-connection read for requireStaffRole authz.
export { platformStaffRepository } from "./repositories/platformStaffRepository.ts";
// Staff support notes (13a Area 3) — owner-connection, audited writes; deny-all to the customer app role.
export {
  supportNoteRepository,
  type SupportNoteRow,
} from "./repositories/supportNoteRepository.ts";
// Account holds (13a Area 7) — staff abuse/fraud holds; owner-connection, audited writes; deny-all to app role.
export {
  accountHoldRepository,
  type AccountHoldRow,
} from "./repositories/accountHoldRepository.ts";
// Announcements (13a Area 10) — staff-authored banners; admin writes via withPlatformTx, customer read is an
// owner-connection, server-scoped projection.
export {
  announcementRepository,
  type AnnouncementRow,
  type ActiveAnnouncementRow,
  type AnnouncementWrite,
} from "./repositories/announcementRepository.ts";
// Platform billing/economics reads (13a Area 4) — cross-tenant aggregates, run within withPlatformTx.
export {
  platformBillingReadRepository,
  type EconomicsAggregate,
  type EconomicsTrendRow,
  type TenantEconomicsDetailAggregate,
  type PlatformPurchaseRow,
} from "./repositories/platformBillingReads.ts";
// Platform data-quality reads (P5 cockpit) — cross-tenant DQ rollup + re-verification ledger, within withPlatformTx.
export {
  platformDataQualityReadRepository,
  type DataQualityRollup,
  type VerificationRunRow,
  type VerificationTotals,
} from "./repositories/platformDataQualityReads.ts";
// Platform trust/abuse reads (P6) — cross-tenant signup velocity, active holds, status mix; within withPlatformTx.
export {
  platformTrustReadRepository,
  type SignupVelocity,
  type CountBucket,
  type TrustSignals,
} from "./repositories/platformTrustReads.ts";
// Platform compliance-ops reads (13a Area 8) — global DSAR queue (PII-free), run within withPlatformTx.
export {
  platformComplianceReadRepository,
  type PlatformDsarRow,
} from "./repositories/platformComplianceReads.ts";
// Retention policies (13a Area 8) — staff-authored retention SLAs; owner-connection, audited writes.
export {
  retentionPolicyRepository,
  type RetentionPolicyRow,
  type RetentionPolicyWrite,
} from "./repositories/retentionPolicyRepository.ts";
// Sub-processor registry (13a Area 8 / GDPR Art. 28) — staff-published config; owner-connection, audited writes.
export {
  subProcessorRepository,
  type SubProcessorRow,
  type SubProcessorWrite,
} from "./repositories/subProcessorRepository.ts";
// Credit-pack pricing catalog (13a Area 5) — staff-authored config; owner-connection, audited writes.
export {
  creditPackRepository,
  type CreditPackRow,
  type UpsertCreditPackInput,
} from "./repositories/creditPackRepository.ts";
export { stripeCustomerRepository } from "./repositories/stripeCustomerRepository.ts";
export {
  subscriptionRepository,
  billingCycleRepository,
  type SubscriptionRow,
  type UpsertSubscriptionInput,
  type DueCycleRow,
} from "./repositories/subscriptionRepository.ts";
export {
  teamRepository,
  type TeamRow,
  type TeamMemberRow,
} from "./repositories/teamRepository.ts";
// Plan/entitlement template catalog (13a Area 5) — staff-authored config; owner-connection, audited writes.
export {
  planTemplateRepository,
  type PlanTemplateRow,
  type UpsertPlanTemplateInput,
} from "./repositories/planTemplateRepository.ts";
// JIT elevation grants (13a F1) — audited, time-boxed, tenant-scoped step-up for sensitive admin actions.
export {
  jitElevationRepository,
  JIT_ELEVATION_TTL_SECONDS,
  type GrantElevationInput,
  type JitElevationRow,
} from "./repositories/jitElevationRepository.ts";
// Provider configs (13 §3.6) — platform-global enable/budget + cross-tenant month-to-date spend.
export {
  providerConfigRepository,
  type ProviderConfigRow,
} from "./repositories/providerConfigRepository.ts";
// Tenant SSO config (17 §7) — the Auth Admin Single sign-on record (tenant-scoped, audited).
export {
  ssoConfigRepository,
  type SsoConfigUpsertValues,
} from "./repositories/ssoConfigRepository.ts";
// Domain claiming + SCIM tokens (ADR-0020, enterprise IAM) — tenant-scoped, audited.
export { domainRepository, type DomainRecord } from "./repositories/domainRepository.ts";
export {
  scimTokenRepository,
  type ScimTokenRecord,
  type ScimTokenAuth,
} from "./repositories/scimTokenRepository.ts";
// Platform audit-log read surface (ADR-0032) — bounded cross-tenant read, run within withPlatformTx.
export {
  platformAuditReadRepository,
  AUDIT_EXPORT_CAP,
  type PlatformAuditRow,
  type TenantStaffAccessRow,
} from "./repositories/platformAuditReads.ts";
// Platform STAFF RBAC writes + impersonation-with-consent (ADR-0011) — owner-connection, audited.
export { staffRepository, type StaffMemberRow } from "./repositories/staffRepository.ts";
export {
  impersonationRepository,
  IMPERSONATION_TTL_MINUTES,
  type ImpersonationStartValues,
  type ImpersonationSessionRow,
} from "./repositories/impersonationRepository.ts";
export {
  webhookRepository,
  type WebhookSubscriptionInsert,
  type WebhookSubscriptionRecord,
  type WebhookDispatchTarget,
  type WebhookDeliveryInsert,
  type WebhookDeliveryRecord,
  type WebhookDeliveryForReplay,
} from "./repositories/webhookRepository.ts";
export {
  importMappingTemplateRepository,
  type ImportMappingTemplateSaveValues,
  type ImportMappingTemplateRecord,
} from "./repositories/importMappingTemplateRepository.ts";
export {
  featureFlagRepository,
  type FeatureFlagRecord,
  type TenantFeatureFlagRecord,
  type FeatureFlagUpsertValues,
} from "./repositories/featureFlagRepository.ts";
// In-app notifications (G-NTF-1) — the workspace-scoped, per-user notification feed. Producers create; the
// recipient lists/marks-read. RLS bounds the workspace; the repo enforces per-user visibility.
export {
  notificationRepository,
  type NotificationRow,
  type CreateNotificationInput,
} from "./repositories/notificationRepository.ts";
export {
  aiRequestRepository,
  type CreateAiRequestInput,
  type AiUsageByTenant,
} from "./repositories/aiRequestRepository.ts";
// M12 email subsystem (email-planning/13 P0) — the net-new persistence that EXTENDS the M9 outreach engine
// (D11): per-tenant sending identity, connected mailboxes (encrypted creds), the raw tracking firehose, and
// the per-tenant send-quota (the creditRepository lock discipline).
export {
  sendingDomainRepository,
  type SendingDomainInsert,
  type SendingDomainRecord,
  type DomainAuthState,
} from "./repositories/sendingDomainRepository.ts";
export {
  mailboxRepository,
  type MailboxInsert,
  type MailboxRecord,
  type MailboxDueRow,
} from "./repositories/mailboxRepository.ts";
export {
  oauthConnectStateRepository,
  type ConnectStateInsert,
  type ConnectStateRecord,
} from "./repositories/oauthConnectStateRepository.ts";
// M12 P1 outbound persistence / P3 inbox — the conversation + per-message store (rfc822 Message-ID threading
// key). Net-new, additive to outreach_log/sendStep (D11). Bodies encrypted (D7), never projected to the API.
export {
  emailThreadRepository,
  type ThreadInsert,
} from "./repositories/emailThreadRepository.ts";
export {
  emailMessageRepository,
  type MessageInsert,
} from "./repositories/emailMessageRepository.ts";
export {
  emailEventRepository,
  type EmailEventType,
  type EmailEventInsert,
  type EmailEventRow,
} from "./repositories/emailEventRepository.ts";
export {
  sendQuotaRepository,
  SendQuotaExceededError,
  type QuotaSnapshot,
  type QuotaReadout,
} from "./repositories/sendQuotaRepository.ts";
export {
  emailTemplateRepository,
  type TemplateInsert,
  type VersionInsert,
  type TemplateRecord,
  type TemplateSummaryRow,
  type TemplateDetailRow,
  type TemplateVersionRow,
  type TemplateListCursor,
  type TemplateListRow,
} from "./repositories/emailTemplateRepository.ts";
export {
  schedulerRepository,
  type ClaimedEnrollment,
} from "./repositories/schedulerRepository.ts";
export {
  emailAnalyticsRepository,
  type EmailMetricCounts,
} from "./repositories/emailAnalyticsRepository.ts";
