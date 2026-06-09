// Public surface of @leadwolf/db — the tenancy-scoped client + the auth-domain repositories. Repositories
// are the ONLY data-access layer; callers import them from here, never the schema or client internals.
export { db, withTenantTx, type Db, type Tx, type TenantScope } from "./client.ts";
export * as schema from "./schema/index.ts";
export {
  userRepository,
  sessionRepository,
  type UserRecord,
  type SessionRecord,
  type CreateSessionInput,
  type MfaMethodRecord,
} from "./repositories/userRepository.ts";
export {
  workspaceRepository,
  type WorkspaceSummary,
} from "./repositories/workspaceRepository.ts";
