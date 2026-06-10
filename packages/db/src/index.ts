// Public surface of @leadwolf/db — the tenancy-scoped client + the auth-domain repositories. Repositories
// are the ONLY data-access layer; callers import them from here, never the schema or client internals.
export { db, withTenantTx, closeDb, type Db, type Tx, type TenantScope } from "./client.ts";
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
} from "./repositories/contactRepository.ts";
export {
  sourceImportRepository,
  type SourceImportInput,
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
} from "./repositories/creditRepository.ts";
export {
  suppressionRepository,
  type SuppressionKeys,
  type SuppressionHit,
  type SuppressionEntryInput,
} from "./repositories/suppressionRepository.ts";
export { auditRepository, type AuditEntryInput } from "./repositories/auditRepository.ts";
export {
  idempotencyRepository,
  type StoredResponse,
} from "./repositories/idempotencyRepository.ts";
