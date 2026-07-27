// Public surface of @leadwolf/auth-client — the ONE token client behind apps/web, apps/admin and apps/forge
// (T-2.3, ADR-0016). It existed three times and had drifted: web carried an in-flight refresh de-dup and the
// cross-tab election, admin and forge carried neither. What actually differs per app is parametric — the
// app's own origin and a sessionStorage key prefix — so it is a factory, not a copy.
export {
  type AuthClient,
  type AuthClientConfig,
  type RecoveryAction,
  createAuthClient,
  recoveryActionFor,
} from "./createAuthClient.ts";
export { createPkcePair, randomState } from "./pkce.ts";
export {
  type ElectionChannel,
  type ElectionDeps,
  type ElectionStorage,
  type RefreshResult,
  LOCK_TTL_MS,
  broadcastRefreshResult,
  parseRefreshMessage,
  releaseRefreshLock,
  tryAcquireRefreshLock,
} from "./refreshElection.ts";
