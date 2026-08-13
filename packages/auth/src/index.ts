// Public surface of @leadwolf/auth — the self-built auth primitives consumed by apps/auth (the IdP origin)
// and apps/api (token verification). No HTTP here; transports live in the apps. (17, ADR-0016/17/18.)
export { hashPassword, verifyPassword } from "./password.ts";
export {
  createSession,
  rotateSession,
  revokeSession,
  revokeAllSessionsForUser,
  hashRefreshToken,
  cappedSessionExpiry,
  type IssuedSession,
  type SessionContext,
} from "./session.ts";
export { ipInCidr, isIpAllowed } from "./ipAllowlist.ts";
export { markRevoked, markManyRevoked, isRevoked } from "./revocation.ts";
export { refreshAccessToken, type RefreshResult } from "./refresh.ts";
export { switchWorkspace, type SwitchWorkspaceResult } from "./switchWorkspace.ts";
export { switchOrg, type SwitchOrgResult } from "./switchOrg.ts";
export {
  mintAccessToken,
  verifyAccessToken,
  getJwks,
  assertSigningKey,
  type MintAccessTokenInput,
} from "./token.ts";
export { issueCode, exchangeCode, validateBinding, type CodeBinding } from "./code.ts";
export {
  normalizeIp,
  clientIpMatches,
  clientIp,
  clientIpFromHeaders,
  type IpBindMode,
  type HeaderReader,
} from "./ipBinding.ts";
export { log } from "./log.ts";
export {
  recordAuthMetric,
  renderAuthMetrics,
  __resetAuthMetrics,
  type AuthMetricName,
  type AuthMetricLabels,
} from "./authMetrics.ts";
export { authenticatePassword, type AuthenticatedUser } from "./login.ts";
export {
  createLoginTransaction,
  getLoginTransaction,
  patchLoginTransaction,
  deleteLoginTransaction,
  type LoginTransaction,
  type LoginTransactionInput,
} from "./loginTransaction.ts";
export {
  resolveNextStep,
  finalizeLogin,
  isActiveTenantMember,
  isActiveWorkspaceMember,
  type LoginStep,
  type FinalizedLogin,
} from "./flow.ts";
export { authorizeTenantSelection } from "./scopeGuard.ts";
export { verifyMfaCode, requestEmailOtp } from "./mfaVerify.ts";
export {
  type WebauthnCeremony,
  storeWebauthnChallenge,
  consumeWebauthnChallenge,
} from "./webauthnChallenge.ts";
export {
  type RegistrationResponseJSON,
  generatePasskeyRegistration,
  verifyPasskeyRegistration,
} from "./webauthnRegistration.ts";
export {
  type AuthenticationResponseJSON,
  generatePasskeyAuthentication,
  generatePasskeyAuthenticationUsernameless,
  verifyPasskeyAuthentication,
  verifyPasskeyAuthenticationUsernameless,
} from "./webauthnAuthentication.ts";
export { encryptSecret, decryptSecret } from "./secrets.ts";
export {
  lookupIdentifier,
  type DomainResolver,
  type DomainRouting,
} from "./identifierLookup.ts";
export { verifyTurnstile } from "./botCheck.ts";
export {
  checkIdentifierRate,
  checkRequestRate,
  checkCaptureRate,
  checkRevealRate,
  checkEmailOtpSendRate,
  assertCredentialNotLocked,
  recordCredentialFailure,
  recordCredentialSuccess,
} from "./rateLimit.ts";
// The fail-open guard marker (audit 32 · C11). Exported because apps/api's entitlement gate is one of the
// guards that opens, and all of them must emit the same shape for one alert expression to catch them.
export { type OpenGuard, guardDegradedLog, makeDegradedThrottle } from "./guardDegradedLog.ts";
// Tenant-suspension decision (audit 32 §9E). Exported so the other tenant-selection paths (refresh,
// switchWorkspace, and finalizeLogin's org pick) can adopt the same decision rather than re-deriving it.
export {
  type SuspensionDecision,
  type SuspensionMode,
  suspensionMode,
  tenantSuspensionDecision,
  tenantSuspensionLog,
} from "./tenantSuspension.ts";
export {
  createEmailVerification,
  verifyEmailCode,
  type EmailTokenPurpose,
} from "./emailVerification.ts";
export {
  requestPasswordReset,
  completePasswordReset,
  type RequestPasswordResetInput,
  type RequestPasswordResetResult,
  type CompletePasswordResetInput,
  type CompletePasswordResetResult,
} from "./passwordReset.ts";
export {
  createSignupTransaction,
  getSignupTransaction,
  patchSignupTransaction,
  deleteSignupTransaction,
  type SignupTransaction,
  type SignupTransactionInput,
} from "./signupTransaction.ts";
export {
  provisionIdentity,
  type ProvisionIdentityInput,
  type ProvisionedIdentity,
  type Placement,
} from "./registration.ts";
export {
  createInvitation,
  acceptInvitationToken,
  type CreateInvitationInput,
  type AcceptInvitationResult,
} from "./invitations.ts";
export { getSsoProvider, isSsoProviderWired, ssoReadyForEnforcement } from "./sso/providers.ts";
export { signMockAssertion } from "./sso/mockIdp.ts";
export { provisionSsoIdentity } from "./sso/jit.ts";
export type { SsoConfig, SsoAssertion, SsoInitiation, SsoProvider } from "./sso/types.ts";
export {
  createSsoTransaction,
  getSsoTransaction,
  deleteSsoTransaction,
  type SsoTransaction,
  type SsoTransactionInput,
} from "./ssoTransaction.ts";
export {
  verifyTotp,
  matchRecoveryCode,
  generateTotpSecret,
  totpKeyUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./mfa.ts";
export {
  resolveEffectivePolicy,
  strictestMfa,
  isMethodAllowed,
  composeEffectivePolicy,
  assembleScopePolicy,
  resolvePolicyFromRows,
  findFloorViolations,
  parsePolicyKeyValue,
  validatePolicyWrite,
} from "./policy.ts";
export type { PolicyWriteDecision } from "./policy.ts";
export type { AuthPolicyRow } from "./policy.ts";
export { recordAuthEvent, recordPlatformAuthEvent } from "./auditEvent.ts";
export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  validatePasswordShape,
  checkPasswordAcceptable,
  passwordRejectionMessage,
  type PasswordRejection,
} from "./passwordPolicy.ts";
export { isPasswordBreached } from "./breachCheck.ts";
