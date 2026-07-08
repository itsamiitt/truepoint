// auditCoverage.test.ts — drift guard for the closed audit_log.action vocabulary.
// Pure unit test (no DB): every value in the closed `auditAction` enum (08 §5; the source of truth in
// billing.ts) must be accounted for as either WRITTEN (has a verified writeAudit() call-site today) or
// PENDING (defined but not yet wired to a writer). Adding or removing an action without updating this
// bookkeeping fails the test — keeping docs/planning/audit-log-enum.md §5 honest and the [02 §6]
// "every mutating action is audited" contract from silently regressing. As each PENDING action lands a
// writer, move it into WRITTEN here and update audit-log-enum.md §5.

import { describe, expect, it } from "bun:test";
import { auditAction } from "./billing.ts";

// §5.1 — actions with a verified writeAudit() call-site (packages/core: reveal, outreach, compliance).
const WRITTEN = new Set<string>([
  "reveal",
  "reveal.blocked",
  "send",
  "enroll",
  "sequence.create",
  "sequence.update",
  "suppression.add",
  "credit.adjust",
  "consent.record",
  "consent.withdraw",
  "dsar.access",
  "dsar.delete",
  // Phase-3 bulk actions over the prospect search results (24; packages/core bulkActions): owner reassign +
  // status change → contact.update; soft-archive → contact.delete; bulk tags → tag.assign / tag.unassign;
  // role-gated CSV export → export.
  "contact.update",
  "contact.delete",
  "tag.assign",
  "tag.unassign",
  "export",
  // auth events wired via recordAuthEvent (packages/auth, ADR-0031)
  "login.success",
  "signup",
  "sso.initiated",
  "sso.callback",
  "token.issued",
  "code.exchanged",
  // password.reset.complete writes audit_log when the identity resolves to a SINGLE tenant (ADR-0031 §2); the
  // 0/>1-tenant case routes to platform_audit_log instead (see platformAuditCoverage.test.ts).
  "password.reset.complete",
  // Workspace members management (P1-03; packages/core auth/members): invite → member.add; role change →
  // member.update; remove member / revoke invite → member.remove.
  "member.add",
  "member.update",
  "member.remove",
  // MFA enrollment (P1-01): forced in-login TOTP enroll (apps/auth /mfa/enroll) and self-service enroll
  // (/account/security) both recordAuthEvent("mfa.enroll") once the method is persisted; tenant is resolved
  // at that point, so it lands in audit_log (not the platform sink).
  "mfa.enroll",
  // Email M12 P0 (packages/core email): connect a workspace mailbox → mailbox.connect (connectMailbox.ts);
  // create + DNS-verify a per-tenant sending domain → sending_domain.add / sending_domain.verify (sendingDomains.ts).
  "mailbox.connect",
  "sending_domain.add",
  "sending_domain.verify",
  // AUTH-024 — passkey (WebAuthn) credential added / removed from account security (auditPasskeyChange, the
  // tenant branch → audit_log; the tenant-less branch → platform_audit_log).
  "passkey.register",
  "passkey.remove",
  // AUTH — self-service session revoke (auditSessionRevoke, tenant branch → audit_log; now fully wired via the
  // dual-sink, so no longer PENDING).
  "session.revoked",
]);

// §5.2 — defined in the closed enum but not yet wired to a writeAudit() call-site.
const PENDING = new Set<string>([
  // data / money / compliance (no existing service path yet)
  "unsubscribe",
  "suppression.remove",
  "dsar.rectify",
  "apikey.use",
  // Email M12 (packages/core email): disconnecting a mailbox has no service path yet (the connect/verify
  // writers landed in P0; mailbox.disconnect lands with the mailbox-management surface).
  "mailbox.disconnect",
  // record / config mutations (services land at M8 / M16)
  "contact.create",
  "account.create",
  "account.update",
  "account.delete",
  "list.create",
  "list.update",
  "list.delete",
  "sequence.delete",
  "template.create",
  "template.update",
  "template.delete",
  "settings.update",
  "automation.rule.create",
  "automation.rule.update",
  "automation.rule.delete",
  // record customization (M8 / ADR-0028) + automation lifecycle (M16 / ADR-0026) + AI (M14 / ADR-0023),
  // added per ADR-0032 — services not yet built, so no writer call-site.
  "custom_field.create",
  "custom_field.update",
  "custom_field.delete",
  "tag.create",
  "tag.update",
  "tag.delete",
  "pipeline_stage.create",
  "pipeline_stage.update",
  "pipeline_stage.delete",
  "pipeline_stage.assign",
  "saved_search.create",
  "saved_search.update",
  "saved_search.delete",
  "automation.rule.enable",
  "automation.rule.disable",
  "automation.rule.run",
  "ai.config.update",
  "ai.draft.approve",
  "ai.draft.reject",
  // auth events — tenant-resolved ones are wired (ADR-0031); these stay pending because they are
  // pre-tenant (→ platform_audit_log, OQ-D), high-volume (token.refresh), or have no flow yet.
  "login.failure",
  "login.locked",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "token.refresh",
  "token.revoke",
  "device.trusted",
  "device.revoked",
  "code.issued",
  "oauth.link",
]);

describe("audit_log.action coverage", () => {
  const all = [...auditAction.options].sort();

  it("WRITTEN ∪ PENDING exactly covers the closed enum", () => {
    const union = [...new Set([...WRITTEN, ...PENDING])].sort();
    expect(union).toEqual(all);
  });

  it("WRITTEN and PENDING are disjoint", () => {
    const both = [...WRITTEN].filter((action) => PENDING.has(action));
    expect(both).toEqual([]);
  });

  it("every bookkeeping entry is a real enum member (no stale literal)", () => {
    const members = new Set<string>(auditAction.options);
    const stale = [...WRITTEN, ...PENDING].filter((action) => !members.has(action));
    expect(stale).toEqual([]);
  });
});
