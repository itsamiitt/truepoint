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
  // auth events wired via recordAuthEvent (packages/auth, ADR-0031)
  "login.success",
  "signup",
  "sso.initiated",
  "sso.callback",
  "token.issued",
  "code.exchanged",
]);

// §5.2 — defined in the closed enum but not yet wired to a writeAudit() call-site.
const PENDING = new Set<string>([
  // data / money / compliance (no existing service path yet)
  "export",
  "unsubscribe",
  "suppression.remove",
  "dsar.rectify",
  "member.add",
  "member.update",
  "member.remove",
  "apikey.use",
  // record / config mutations (services land at M8 / M16)
  "contact.create",
  "contact.update",
  "contact.delete",
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
  // auth events — tenant-resolved ones are wired (ADR-0031); these stay pending because they are
  // pre-tenant (→ platform_audit_log, OQ-D), high-volume (token.refresh), or have no flow yet.
  "login.failure",
  "login.locked",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "password.reset.complete",
  "token.refresh",
  "token.revoke",
  "device.trusted",
  "device.revoked",
  "session.revoked",
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
