// emailPrescreen.ts — a zero-network LOCAL pre-screen wrapped around the email verifier (06 §9, 01 §5.2). Before
// spending a Reacher SMTP probe (paid + ~seconds of latency on the monetized reveal path), two cheap,
// high-confidence local checks short-circuit the obvious cases:
//   • a DISPOSABLE domain (mailinator.com, …) → "invalid" — throwaway inboxes are non-deliverable junk;
//   • a ROLE local-part (info@, sales@, support@, …) → "risky" — a shared mailbox, not a 1:1 prospect.
// Both are exactly what Reacher returns for these classes (is_disposable / is_role_account), so the pre-screen is
// grade-equivalent — it only saves the call, never changes a real verdict. Anything else delegates to the wrapped
// verifier, which still catches the long tail (the lists are a curated COMMON-CASE set, not exhaustive). Pure +
// offline → fully unit-testable.

import type { EmailStatus } from "@leadwolf/types";
import type { EmailVerifierPort } from "./emailVerifier.ts";

/** Common shared-mailbox local-parts → "risky" (a role inbox is not a 1:1 prospect; matches Reacher's role flag). */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set(
  "info sales support admin administrator contact hello help team billing accounts accounting hr jobs careers recruiting marketing office mail enquiries inquiries enquiry inquiry service services noreply no-reply donotreply postmaster abuse webmaster sysadmin feedback press media legal compliance privacy security".split(" "),
);

/** Common disposable/throwaway email domains → "invalid". A curated starter set; the wrapped verifier
 *  (Reacher's is_disposable) catches the long tail. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(
  "mailinator.com guerrillamail.com guerrillamail.net 10minutemail.com tempmail.com temp-mail.org throwawaymail.com yopmail.com trashmail.com getnada.com dispostable.com maildrop.cc mintemail.com fakeinbox.com sharklasers.com spam4.me mailnesia.com mohmal.com emailondeck.com".split(" "),
);

/** Split an email into a lowercased { local, domain }; null for a malformed address (no usable `@`). */
function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return {
    local: email.slice(0, at).toLowerCase().trim(),
    domain: email.slice(at + 1).toLowerCase().trim(),
  };
}

/** A role/shared-mailbox local-part (exact match on the part before any `+tag`). */
export function isRoleAccount(email: string): boolean {
  const parts = splitEmail(email);
  if (!parts) return false;
  const base = parts.local.split("+", 1)[0] ?? parts.local; // strip any +tag suffix
  return ROLE_LOCAL_PARTS.has(base);
}

/** A known disposable/throwaway domain. */
export function isDisposableDomain(email: string): boolean {
  const parts = splitEmail(email);
  return parts ? DISPOSABLE_DOMAINS.has(parts.domain) : false;
}

/**
 * Wrap a verifier with the local pre-screen. Disposable domain → "invalid", role local-part → "risky" (both
 * WITHOUT calling `inner`); everything else delegates to `inner.verify`. Grade-equivalent to what the wrapped
 * verifier returns for these classes, so it only saves the call — it never overrides a real determination.
 */
export function localPrescreenVerifier(inner: EmailVerifierPort): EmailVerifierPort {
  return {
    name: `prescreen(${inner.name})`,
    verify(email: string, currentStatus: EmailStatus): Promise<EmailStatus> {
      if (isDisposableDomain(email)) return Promise.resolve("invalid");
      if (isRoleAccount(email)) return Promise.resolve("risky");
      return inner.verify(email, currentStatus);
    },
  };
}
