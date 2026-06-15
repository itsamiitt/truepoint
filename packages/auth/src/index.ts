// Public surface of @leadwolf/auth — the self-built auth primitives consumed by apps/auth (the IdP origin)
// and apps/api (token verification). No HTTP here; transports live in the apps. (17, ADR-0016/17/18.)
export { hashPassword, verifyPassword } from "./password.ts";
export {
  createSession,
  rotateSession,
  revokeSession,
  hashRefreshToken,
  type IssuedSession,
  type SessionContext,
} from "./session.ts";
export { refreshAccessToken, type RefreshResult } from "./refresh.ts";
export {
  mintAccessToken,
  verifyAccessToken,
  getJwks,
  type MintAccessTokenInput,
} from "./token.ts";
export { issueCode, exchangeCode, type CodeBinding } from "./code.ts";
export { authenticatePassword, type AuthenticatedUser } from "./login.ts";
export {
  createLoginTransaction,
  getLoginTransaction,
  patchLoginTransaction,
  deleteLoginTransaction,
  type LoginTransaction,
  type LoginTransactionInput,
} from "./loginTransaction.ts";
export { resolveNextStep, finalizeLogin, type LoginStep, type FinalizedLogin } from "./flow.ts";
export { verifyMfaCode } from "./mfaVerify.ts";
export { encryptSecret, decryptSecret } from "./secrets.ts";
export {
  lookupIdentifier,
  type DomainResolver,
  type DomainRouting,
} from "./identifierLookup.ts";
export { verifyTurnstile } from "./botCheck.ts";
export { checkIdentifierRate, checkRequestRate } from "./rateLimit.ts";
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
export { getSsoProvider } from "./sso/providers.ts";
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
export { verifyTotp, matchRecoveryCode } from "./mfa.ts";
export {
  resolveEffectivePolicy,
  strictestMfa,
  isMethodAllowed,
} from "./policy.ts";
export { recordAuthEvent } from "./auditEvent.ts";
