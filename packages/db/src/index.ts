// Public surface of @leadwolf/db — the tenancy-scoped client + the auth-domain repositories. Repositories
// are the ONLY data-access layer; callers import them from here, never the schema or client internals.
export {
  db,
  withTenantTx,
  withPrivilegedTx,
  withPlatformTx,
  closeDb,
  type Db,
  type Tx,
  type TenantScope,
  type PlatformActor,
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
  type CreateSessionInput,
  type MfaMethodRecord,
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
  type TenantMembership,
  type DomainResolution,
  type SsoConfigRecord,
  type PendingInvitation,
  type InvitationByToken,
  type CreateInvitationInput,
} from "./repositories/workspaceRepository.ts";
export { accountRepository, type AccountUpsertInput } from "./repositories/accountRepository.ts";
export {
  contactRepository,
  type ContactWriteValues,
  type DedupKeys,
  type HotLeadRow,
} from "./repositories/contactRepository.ts";
export {
  sourceImportRepository,
  type SourceImportInput,
  type ImportBatchRow,
} from "./repositories/sourceImportRepository.ts";
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
} from "./repositories/auditRepository.ts";
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
