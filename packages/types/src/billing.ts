// billing.ts — shared vocabulary for the money loop (07, 09 §3) + suppression and the closed audit-action
// enum (08 §5). Mirrored as SQL CHECKs in packages/db/src/schema/billing.ts — this file is the source of truth.

import { z } from "zod";

// ── Reveal (07 §1/§3) ──────────────────────────────────────────────────────────────────────────────────
export const revealType = z.enum(["email", "phone", "full_profile"]);
export type RevealType = z.infer<typeof revealType>;

export const revealDataSource = z.enum(["apollo", "zoominfo", "linkedin", "internal"]);
export type RevealDataSource = z.infer<typeof revealDataSource>;

export const revealRequestSchema = z.object({ reveal_type: revealType });

/** The 09 §3.2 reveal response. PII appears here ONLY — never in masked search/list payloads. */
export const revealResponseSchema = z.object({
  contactId: z.string().uuid(),
  reveal_type: revealType,
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  emailStatus: z.string().optional(),
  creditsCharged: z.number().int().min(0),
  balanceAfter: z.number().int().min(0),
  alreadyOwned: z.boolean(),
});
export type RevealResponse = z.infer<typeof revealResponseSchema>;

/** One metered reveal from GET /credits/usage — the usage-history row (07 §9, 09 §3, 12 §4). PII-free: the
 *  reveal's id/contact/type/cost/timestamp plus the member who ran it (the Reports "member" dimension).
 *  Single source of truth for apps/api (the /credits/usage payload) and apps/web (Settings ▸ Billing, Reports). */
export const usageRevealSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  revealType: revealType,
  creditsConsumed: z.number().int().min(0),
  revealedAt: z.string().datetime({ offset: true }),
  revealedByUserId: z.string(), // contact_reveals.revealed_by_user_id (NOT NULL) — the member who revealed.
});
export type UsageReveal = z.infer<typeof usageRevealSchema>;

// ── Suppression / DNC (08 §3) ──────────────────────────────────────────────────────────────────────────
export const suppressionScope = z.enum(["global", "tenant", "workspace"]);
export type SuppressionScope = z.infer<typeof suppressionScope>;

export const suppressionMatchType = z.enum(["email", "domain", "phone", "contact_id"]);
export type SuppressionMatchType = z.infer<typeof suppressionMatchType>;

// ── Audit actions — the CLOSED enum (08 §5; record/config mutations added by the 28 §3.17 remediation) ──
export const auditAction = z.enum([
  // data / money / compliance
  "reveal",
  "reveal.blocked",
  "export",
  "send",
  "enroll",
  "unsubscribe",
  "suppression.add",
  "suppression.remove",
  "consent.record",
  "consent.withdraw",
  "dsar.access",
  "dsar.delete",
  "dsar.rectify",
  "member.add",
  "member.update",
  "member.remove",
  "apikey.use",
  "credit.adjust",
  // record/config mutations (28 G-CMP-1)
  "contact.create",
  "contact.update",
  "contact.delete",
  "account.create",
  "account.update",
  "account.delete",
  "list.create",
  "list.update",
  "list.delete",
  "sequence.create",
  "sequence.update",
  "sequence.delete",
  "template.create",
  "template.update",
  "template.delete",
  "settings.update",
  "automation.rule.create",
  "automation.rule.update",
  "automation.rule.delete",
  // record-customization mutations (M8 / ADR-0028, added per ADR-0032)
  "custom_field.create",
  "custom_field.update",
  "custom_field.delete",
  "tag.create",
  "tag.update",
  "tag.delete",
  "tag.assign",
  "tag.unassign",
  "pipeline_stage.create",
  "pipeline_stage.update",
  "pipeline_stage.delete",
  "pipeline_stage.assign",
  "saved_search.create",
  "saved_search.update",
  "saved_search.delete",
  // automation lifecycle (M16 / ADR-0026, added per ADR-0032)
  "automation.rule.enable",
  "automation.rule.disable",
  "automation.rule.run",
  // AI intelligence layer (M14 / ADR-0023, added per ADR-0032)
  "ai.config.update",
  "ai.draft.approve",
  "ai.draft.reject",
  // M12 email subsystem (email-planning/13 P0) — connecting a mailbox stores a LIVE credential and verifying
  // a sending domain changes send-eligibility; both are security-sensitive and audited (IDs + actions only).
  "mailbox.connect",
  "mailbox.disconnect",
  "sending_domain.add",
  "sending_domain.verify",
  // auth events (17 §9)
  "login.success",
  "login.failure",
  "login.locked",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "mfa.enroll",
  "password.reset.request",
  "password.reset.complete",
  "sso.initiated",
  "sso.callback",
  "token.issued",
  "token.refresh",
  "token.revoke",
  "device.trusted",
  "device.revoked",
  "session.revoked",
  "code.issued",
  "code.exchanged",
  "signup",
  "oauth.link",
]);
export type AuditAction = z.infer<typeof auditAction>;
