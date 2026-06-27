// email.ts — shared vocabulary for the M12 email subsystem (email-planning/13 P0, 02/03/09). The request
// schemas the API validates with and the masked DTOs the web client renders for the NET-NEW persistence
// (sending_domain, mailbox_integration, the per-tenant send-quota). The closed enums mirror the SQL CHECKs
// in packages/db/src/schema/email.ts — that file is the source of truth. SECRETS (SMTP password / OAuth
// token) appear ONLY in the connect REQUEST; no response schema here ever carries a credential (D7).

import { z } from "zod";

// ── Enums (mirror the schema CHECKs) ────────────────────────────────────────────────────────────────────
export const mailboxProvider = z.enum(["google", "microsoft", "smtp", "ses"]);
export type MailboxProvider = z.infer<typeof mailboxProvider>;

export const mailboxStatus = z.enum(["pending", "connected", "error", "disconnected"]);
export type MailboxStatus = z.infer<typeof mailboxStatus>;

export const sendingDomainStatus = z.enum(["pending", "verifying", "verified", "failed"]);
export type SendingDomainStatus = z.infer<typeof sendingDomainStatus>;

export const dnsAuthState = z.enum(["unverified", "pass", "fail"]);
export type DnsAuthState = z.infer<typeof dnsAuthState>;

// ── Unified inbox (M12 P3) — closed enums mirror the email_thread / email_message CHECKs ─────────────────
export const emailThreadStatus = z.enum(["open", "snoozed", "done"]);
export type EmailThreadStatus = z.infer<typeof emailThreadStatus>;

export const emailMessageDirection = z.enum(["inbound", "outbound"]);
export type EmailMessageDirection = z.infer<typeof emailMessageDirection>;

/** Reply classification (RFC 3834 ≥2-signal heuristic): only `human` counts as a real reply for auto-pause. */
export const emailMessageClassification = z.enum([
  "human",
  "auto_reply",
  "ooo",
  "bounce",
  "unknown",
]);
export type EmailMessageClassification = z.infer<typeof emailMessageClassification>;

// ── Request schemas (09 §3 body naming: snake_case) ─────────────────────────────────────────────────────
/** The OAuth-redirect providers — connected via the consent flow (connect/start), NOT by posting a token. */
export const oauthMailboxProvider = z.enum(["google", "microsoft"]);
export type OAuthMailboxProvider = z.infer<typeof oauthMailboxProvider>;

/** The credential/platform-identity providers — connected directly via POST /mailboxes. */
export const directMailboxProvider = z.enum(["smtp", "ses"]);

/**
 * Connect an SMTP or platform-SES mailbox. The credential is SERVER-SIDE-ONLY and encrypted at rest (D7):
 * `smtp_password` for an SMTP mailbox. `ses` carries no per-mailbox credential (it uses the platform SES
 * identity). Google/Microsoft are NOT accepted here — a raw OAuth token is never posted by the client; those
 * providers use the OAuth redirect flow (POST /mailboxes/connect/start).
 */
export const mailboxConnectSchema = z
  .object({
    provider: directMailboxProvider,
    address: z.string().email().max(255),
    sending_domain_id: z.string().uuid().optional(),
    smtp_password: z.string().min(1).max(2048).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.provider === "smtp" && !val.smtp_password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["smtp_password"],
        message: "smtp_password is required for an SMTP mailbox.",
      });
    }
  });
export type MailboxConnectRequest = z.infer<typeof mailboxConnectSchema>;

/**
 * Start the OAuth connect flow for a Google/Microsoft mailbox. No credential here — the consent screen mints it.
 * `redirect_after` is a SAME-APP ABSOLUTE PATH only (`/...`, not `//...`) so the post-callback redirect can
 * never be pointed off-origin (open-redirect guard); the server still builds the final URL from its own origin.
 */
export const mailboxConnectStartSchema = z.object({
  provider: oauthMailboxProvider,
  login_hint: z.string().email().max(255).optional(),
  redirect_after: z
    .string()
    .max(200)
    .regex(/^\/(?!\/)/, "must be a same-app absolute path (start with '/', not '//')")
    .optional(),
});
export type MailboxConnectStartRequest = z.infer<typeof mailboxConnectStartSchema>;

export const sendingDomainCreateSchema = z.object({
  domain: z.string().min(3).max(255),
  region: z.string().length(2).optional(),
});
export type SendingDomainCreateRequest = z.infer<typeof sendingDomainCreateSchema>;

// ── Response DTOs (masked — NEVER a credential) ─────────────────────────────────────────────────────────
export const mailboxViewSchema = z.object({
  id: z.string().uuid(),
  provider: mailboxProvider,
  address: z.string(),
  sendingDomainId: z.string().uuid().nullable(),
  status: mailboxStatus,
  lastError: z.string().nullable(),
  connectedAt: z.coerce.date().nullable(),
});
export type MailboxView = z.infer<typeof mailboxViewSchema>;

export const sendingDomainViewSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  status: sendingDomainStatus,
  spfState: dnsAuthState,
  dkimState: dnsAuthState,
  dmarcState: dnsAuthState,
  trackingCname: z.string().nullable(),
  trackingCnameState: dnsAuthState,
  region: z.string(),
  verifiedAt: z.coerce.date().nullable(),
});
export type SendingDomainView = z.infer<typeof sendingDomainViewSchema>;

/** The per-tenant send-quota snapshot (15 §A.6). `quota` null = unlimited. */
export const sendQuotaViewSchema = z.object({
  quota: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative(),
  periodStart: z.coerce.date(),
});
export type SendQuotaView = z.infer<typeof sendQuotaViewSchema>;

// ── Templates (M12 P2, 01) ──────────────────────────────────────────────────────────────────────────────
export const emailTemplateChannel = z.enum(["email", "linkedin"]);
export type EmailTemplateChannel = z.infer<typeof emailTemplateChannel>;

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  channel: emailTemplateChannel.default("email"),
  subject: z.string().max(255).nullish(),
  body: z.string().min(1).max(50_000),
  shared: z.boolean().optional(),
});
export type CreateTemplateRequest = z.infer<typeof createTemplateSchema>;

/** A content change (subject+body) appends a new version; name/shared/status are metadata. All optional. */
export const updateTemplateSchema = z
  .object({
    subject: z.string().max(255).nullish(),
    body: z.string().min(1).max(50_000).optional(),
    name: z.string().min(1).max(255).optional(),
    shared: z.boolean().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided." });
export type UpdateTemplateRequest = z.infer<typeof updateTemplateSchema>;

/** GET /templates list row — the shape the Sequences ▸ Templates panel renders. */
export const templateSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  channel: emailTemplateChannel,
  subject: z.string().nullable(),
  body: z.string(),
  updatedAt: z.string(),
});
export type TemplateSummaryDto = z.infer<typeof templateSummarySchema>;
