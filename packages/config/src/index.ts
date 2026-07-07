// Public surface of @leadwolf/config — validated env + origin helpers. Import only from here.
export {
  appEnvSchema,
  env,
  envSurfaceReport,
  appOrigins,
  isAllowedOrigin,
  WORKER_SURFACE,
  type AppEnv,
  type SurfaceReport,
} from "./env.ts";
export {
  resolveAllowedOrigins,
  isOriginAllowed,
  canonicalManagedOrigin,
} from "./managedOrigins.ts";
