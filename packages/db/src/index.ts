// Public surface of @leadwolf/db — the tenancy-scoped client + the auth-domain repositories. Repositories
// are the ONLY data-access layer; callers import them from here, never the schema or client internals.
export {
  db,
  withTenantTx,
  withPrivilegedTx,
  withErTx,
  withPlatformTx,
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
// Layer-0 master graph (ADR-0021; prospect-company-data PLAN_01 §4) — deterministic MATCH-AGAINST resolve-for-
// import. Reads/co-op-safe-mints the system-owned golden graph; always run within withErTx (the leadwolf_er role).
export {
  masterGraphRepository,
  type ResolveForImportInput,
  type ResolveForImportResult,
} from "./repositories/masterGraphRepository.ts";
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
  type EnrichEstimateSignal,
  type HotLeadRow,
  type UnresolvedContactRow,
} from "./repositories/contactRepository.ts";
export {
  verificationJobRepository,
  type VerificationJobRecord,
  type VerificationJobRow,
} from "./repositories/verificationJobRepository.ts";
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
} from "./repositories/revealRepository.ts";
export {
  creditRepository,
  type GrantInput,
  type GrantResult,
  type BurnByDayRow,
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
export {
  enrichmentJobRepository,
  type JobCreateValues,
  type JobRecord,
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
// Platform super-admin read surface (ADR-0032) — bounded cross-tenant reads, run within withPlatformTx.
export {
  platformAdminRepository,
  PLATFORM_READ_LIMIT,
  type PlatformTenantRow,
  type PlatformTenantDetail,
  type PlatformWorkspaceRow,
  type PlatformWorkspaceListRow,
  type PlatformListOverviewRow,
  type PlatformMemberRow,
  type PlatformUserRow,
} from "./repositories/platformAdminReads.ts";
// Platform STAFF role lookup (ADR-0011) — owner-connection read for requireStaffRole authz.
export { platformStaffRepository } from "./repositories/platformStaffRepository.ts";
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
} from "./repositories/mailboxRepository.ts";
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
} from "./repositories/emailTemplateRepository.ts";
export {
  schedulerRepository,
  type ClaimedEnrollment,
} from "./repositories/schedulerRepository.ts";
export {
  emailAnalyticsRepository,
  type EmailMetricCounts,
} from "./repositories/emailAnalyticsRepository.ts";
