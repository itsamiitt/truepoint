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
// TruePoint Forge data-plane config (ADR-0046/0047; nested from @forge/config).
export * from "./forge.ts";
export {
  type Span,
  type SpanAttributes,
  SpanStatusCode,
  activeTraceIds,
  injectTraceContext,
  withExtractedSpan,
  trace,
  withSpan,
} from "./tracing.ts";
