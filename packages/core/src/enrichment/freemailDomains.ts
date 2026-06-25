// freemailDomains.ts — the maintained freemail / role-domain blocklist that stops a consumer/ISP mailbox
// (gmail.com, outlook.com, …) from minting a Layer-0 company node (PLAN_02_affiliation_edge §1.4, F4).
//
// WHY this lives here and NOT inside registrableDomain(): `registrableDomain` (matchKeys.ts:74-81) is the
// SINGLE PSL eTLD+1 normalizer (ADR-0037 / PLAN_00 C5) and must stay PURE — a key derived from a public
// suffix list, nothing else. Folding a freemail blocklist into it (e.g. as a PSL-private section) would
// corrupt that pure eTLD+1 contract. So the blocklist is a separate, code-versioned guard layered ON TOP:
// `companyDomainKey()` calls the pure normalizer, then drops the result if it is a freemail/role domain.
// No domain key → ER leaves `resolved_company_id` NULL → no edge → "company-less" for that signal, never a
// fake "Gmail Inc." (PLAN_02 §1.3, §1.4).

import { registrableDomain } from "./matchKeys.ts";

/**
 * Common consumer/ISP + role mailbox domains that must NEVER mint a company (PLAN_02 §1.4). Seeded from the
 * widely-used public freemail lists; versioned in code (its update cadence/governance is ops, PLAN_02 §1.4
 * residual). Keys are already-registrable (eTLD+1) domains, lowercased — the form `registrableDomain` returns,
 * so the membership test is a direct lookup.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  // Yahoo / Oath
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  // AOL
  "aol.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Proton
  "proton.me",
  "protonmail.com",
  // GMX / Mail.com
  "gmx.com",
  "gmx.net",
  "mail.com",
  // Zoho (personal mailbox host — the org's own domain is the company key, not this)
  "zoho.com",
  // Yandex
  "yandex.com",
  "yandex.ru",
  // China consumer/ISP
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  // Misc common consumer/ISP
  "fastmail.com",
  "hushmail.com",
  "tutanota.com",
]);

/**
 * The COMPANY-side domain key for ER: `registrableDomain(input)` UNLESS that registrable domain is a
 * freemail/role domain, in which case `undefined` (PLAN_02 §1.4 — gate the freemail signal at match-key
 * extraction so it can never mint a company). Pass an email, URL, or raw domain; the pure PSL normalizer
 * does the eTLD+1 reduction, this wrapper only adds the blocklist veto on top.
 */
export function companyDomainKey(input: string | undefined | null): string | undefined {
  const domain = registrableDomain(input);
  if (!domain) return undefined;
  return FREEMAIL_DOMAINS.has(domain) ? undefined : domain;
}
