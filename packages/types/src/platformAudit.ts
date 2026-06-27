// platformAudit.ts — the closed action vocabulary for platform_audit_log (ADR-0032). SEPARATE from the tenant
// audit_log `auditAction` enum (billing.ts) so staff-only + tenant-less identity values never leak into a
// tenant's DSAR/export. Mirrors audit_log's dotted, present-tense convention. The DB-side CHECK constraint
// lands with the apps/admin track (ADR-0032 §5); this enum is the enforced contract at the type boundary now.
import { z } from "zod";

export const platformAuditAction = z.enum([
  // Staff / admin actions (ADR-0011, ADR-0032 §3) — wired with the apps/admin track.
  "tenant.suspend",
  "tenant.reactivate",
  "credit.grant",
  "credit.adjust",
  "plan.override",
  "user.deactivate",
  "user.reactivate",
  "elevation.grant",
  "impersonation.start",
  "impersonation.end",
  "feature_flag.set",
  "provider_config.update",
  "audit.export",
  "staff.login",
  "staff.login.failure",
  // Tenant-less identity events routed here by ADR-0031 §3 (pre-tenant: no single tenant to satisfy
  // audit_log's NOT NULL tenant_id). password.reset.* are wired (P0-01); the rest land with their flows.
  "login.failure",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "password.reset.complete",
]);

export type PlatformAuditAction = z.infer<typeof platformAuditAction>;
